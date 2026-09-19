'use strict';

/*
 * Sửa câu trả lời cấu hình của Dola để bảng chọn trong trang có thêm số giây
 * mà tài khoản không được cấp. Việc này chạy ở tầng khung điều khiển mạng (CDP),
 * sau khi trang nhận câu trả lời thật và trước khi trang đọc nó — nên mọi yêu cầu
 * gửi đi vẫn do trang tự dựng và tự ký, không bị sửa gì.
 */

function parseJson(text) {
  try { return JSON.parse(text); } catch (_) { return null; }
}

function insertDurationOption(list, duration, shape) {
  if (!Array.isArray(list)) return false;
  const wanted = String(duration);
  const exists = list.some((option) => String((option && (option.option_key ?? option.value)) ?? '') === wanted);
  if (exists) return false;
  if (shape === 'pack') {
    list.push({ show_name: `${wanted}s`, value: wanted, is_default: false, sub_display: '' });
  } else {
    const maxId = list.reduce((max, option) => {
      const id = Number(option && option.id);
      return Number.isFinite(id) ? Math.max(max, id) : max;
    }, 0);
    list.push({ id: maxId + 1, display_text: `${wanted}s`, message_text: '', option_key: wanted });
  }
  return true;
}

function patchSkillPack(text, durations) {
  const doc = parseJson(text);
  if (!doc) return { text, changed: false, options: [] };
  const meta = doc && doc.data && doc.data.video_generation && doc.data.video_generation.meta;
  if (!meta) return { text, changed: false, options: [] };
  let changed = false;
  const seen = [];
  for (const selector of (Array.isArray(meta.option_list) ? meta.option_list : [])) {
    const key = String((selector && (selector.value || selector.key)) || '');
    const list = selector && (Array.isArray(selector.options) ? selector.options : (Array.isArray(selector.option_list) ? selector.option_list : null));
    if (!list) continue;
    if (key !== 'duration' && !/duration|时长/i.test(String((selector && (selector.label || selector.show_name)) || ''))) continue;
    for (const duration of durations) changed = insertDurationOption(list, duration, 'pack') || changed;
    seen.push(...list.map((option) => String((option && (option.value ?? option.option_key)) || '')));
  }
  const capability = meta.model_capability;
  if (capability && typeof capability === 'object') {
    for (const model of Object.keys(capability)) {
      const entry = capability[model];
      if (!entry || !Array.isArray(entry.supported_durations)) continue;
      for (const duration of durations) {
        if (!entry.supported_durations.includes(String(duration))) {
          entry.supported_durations.push(String(duration));
          changed = true;
        }
      }
    }
  }
  return { text: changed ? JSON.stringify(doc) : text, changed, options: seen };
}

function patchDurationSelectors(node, durations, seen) {
  if (node === null || typeof node !== 'object') return false;
  if (seen.has(node)) return false;
  seen.add(node);
  let changed = false;
  if (Array.isArray(node)) {
    for (const item of node) changed = patchDurationSelectors(item, durations, seen) || changed;
    return changed;
  }
  const key = String(node.key || node.value || '');
  const label = String(node.label || node.display_text || node.show_name || '');
  const list = Array.isArray(node.option_list) ? node.option_list : null;
  if (list && (key === 'video-duration' || key === 'duration' || /duration|时长/i.test(label))) {
    for (const duration of durations) changed = insertDurationOption(list, duration, 'actionbar') || changed;
  }
  for (const childKey of Object.keys(node)) {
    const child = node[childKey];
    if (typeof child === 'string') {
      const trimmed = child.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        const parsed = parseJson(child);
        if (parsed && patchDurationSelectors(parsed, durations, seen)) {
          node[childKey] = JSON.stringify(parsed);
          changed = true;
        }
      }
    } else {
      changed = patchDurationSelectors(child, durations, seen) || changed;
    }
  }
  return changed;
}

function patchActionBarConfig(text, durations) {
  const doc = parseJson(text);
  if (!doc) return { text, changed: false };
  const changed = patchDurationSelectors(doc, durations, new Set());
  return { text: changed ? JSON.stringify(doc) : text, changed };
}

module.exports = { patchSkillPack, patchActionBarConfig };
