'use strict';

/*
 * Script chạy trong trang Dola (main world) trước mỗi việc.
 *
 * Hai đường để có thời lượng mà UI tài khoản không cho chọn:
 *   1. đường sạch: sửa các câu trả lời cấu hình (skill/pack + action bar) để chính
 *      trang hiện lựa chọn đó, rồi trang tự gửi yêu cầu bằng chữ ký của nó;
 *   2. đường lùi: sửa thời lượng ngay trước khi yêu cầu /chat/completion rời trang.
 * Runner ghi lại đường nào thực sự có tác dụng (patchedResponses / patchedRequests).
 *
 * Ngoài ra script giữ lại các câu trả lời /im/chain/single để runner đọc ra
 * đường dẫn video khi máy chủ trả kết quả.
 */

function buildPageScript(config) {
  const cfg = JSON.stringify(config || {});
  return `(() => {
  const CFG = ${cfg};
  if (window.__dolaRunner && window.__dolaRunner.installed) {
    window.__dolaRunner.cfg = CFG;
    window.__dolaRunner.state.startedAt = new Date().toISOString();
    return { reused: true };
  }

  const state = {
    installedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    patchedResponses: 0,
    patchedRequests: 0,
    chainBodies: [],
    lastError: null,
    notes: []
  };

  const DURATION_LABEL = /duration|时长/i;

  function insertDurationOption(list, duration, shape) {
    if (!Array.isArray(list)) return false;
    const wanted = String(duration);
    const exists = list.some((option) => String((option && (option.option_key ?? option.value)) ?? '') === wanted);
    if (exists) return false;
    if (shape === 'pack') {
      list.push({ show_name: wanted + 's', value: wanted, is_default: false, sub_display: '' });
    } else {
      const maxId = list.reduce((max, option) => {
        const id = Number(option && option.id);
        return Number.isFinite(id) ? Math.max(max, id) : max;
      }, 0);
      list.push({ id: maxId + 1, display_text: wanted + 's', message_text: '', option_key: wanted });
    }
    return true;
  }

  // --- skill/pack: bảng năng lực theo mô hình mà panel Create Videos đọc ---
  function patchSkillPack(text) {
    let doc;
    try { doc = JSON.parse(text); } catch (_) { return text; }
    const meta = doc && doc.data && doc.data.video_generation && doc.data.video_generation.meta;
    if (!meta) return text;
    let changed = false;
    for (const selector of (Array.isArray(meta.option_list) ? meta.option_list : [])) {
      const key = String((selector && (selector.value || selector.key)) || '');
      const list = selector && (Array.isArray(selector.options) ? selector.options : (Array.isArray(selector.option_list) ? selector.option_list : null));
      if (!list) continue;
      if (key !== 'duration' && !DURATION_LABEL.test(String(selector.label || selector.show_name || ''))) continue;
      for (const duration of CFG.durations || []) changed = insertDurationOption(list, duration, 'pack') || changed;
    }
    const capability = meta.model_capability;
    if (capability && typeof capability === 'object') {
      for (const model of Object.keys(capability)) {
        const entry = capability[model];
        if (!entry || !Array.isArray(entry.supported_durations)) continue;
        for (const duration of CFG.durations || []) {
          if (!entry.supported_durations.includes(String(duration))) {
            entry.supported_durations.push(String(duration));
            changed = true;
          }
        }
      }
    }
    return changed ? JSON.stringify(doc) : text;
  }

  // --- action bar: selector "video-duration" nằm trong JSON lồng trong chuỗi JSON ---
  function patchDurationSelectors(node, seen) {
    if (node === null || typeof node !== 'object') return false;
    if (seen.has(node)) return false;
    seen.add(node);
    let changed = false;
    if (Array.isArray(node)) {
      for (const item of node) changed = patchDurationSelectors(item, seen) || changed;
      return changed;
    }
    const key = String(node.key || node.value || '');
    const label = String(node.label || node.display_text || node.show_name || '');
    const list = Array.isArray(node.option_list) ? node.option_list : null;
    if (list && (key === 'video-duration' || key === 'duration' || DURATION_LABEL.test(label))) {
      for (const duration of CFG.durations || []) changed = insertDurationOption(list, duration, 'actionbar') || changed;
    }
    for (const childKey of Object.keys(node)) {
      const child = node[childKey];
      if (typeof child === 'string') {
        const trimmed = child.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(child);
            if (patchDurationSelectors(parsed, seen)) {
              node[childKey] = JSON.stringify(parsed);
              changed = true;
            }
          } catch (_) { /* chuỗi không phải JSON */ }
        }
      } else {
        changed = patchDurationSelectors(child, seen) || changed;
      }
    }
    return changed;
  }

  function patchActionBarConfig(text) {
    let doc;
    try { doc = JSON.parse(text); } catch (_) { return text; }
    const changed = patchDurationSelectors(doc, new Set());
    return changed ? JSON.stringify(doc) : text;
  }

  // --- đường lùi: sửa thời lượng trong envelope gửi đi ---
  function patchCompletionBody(bodyText) {
    if (!bodyText || typeof bodyText !== 'string') return null;
    let outer;
    try { outer = JSON.parse(bodyText); } catch (_) { return null; }
    const ability = outer && outer.chat_ability;
    if (!ability || typeof ability.ability_param !== 'string') return null;
    let param;
    try { param = JSON.parse(ability.ability_param); } catch (_) { return null; }
    if (param.duration === undefined) return null;
    const wanted = Number(CFG.duration);
    if (!wanted || Number(param.duration) === wanted) return null;
    param.duration = wanted;
    ability.ability_param = JSON.stringify(param);
    return JSON.stringify(outer);
  }

  const originalFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : ((input && input.url) || '');
    let nextInit = init;

    if (/\\/chat\\/completion/.test(url) && nextInit && typeof nextInit.body === 'string') {
      const patched = patchCompletionBody(nextInit.body);
      if (patched) {
        nextInit = Object.assign({}, nextInit, { body: patched });
        state.patchedRequests += 1;
      }
    }

    const response = await originalFetch.call(this, input, nextInit);
    try {
      if (/\\/samantha\\/skill\\/pack/.test(url)) {
        const text = await response.clone().text();
        const patched = patchSkillPack(text);
        if (patched !== text) {
          state.patchedResponses += 1;
          state.notes.push('skill/pack đã được thêm ' + (CFG.durations || []).join('/') + 's');
          return new Response(patched, { status: response.status, statusText: response.statusText, headers: response.headers });
        }
      } else if (/action_bar_v3\\/get_item_conf/.test(url)) {
        const text = await response.clone().text();
        const patched = patchActionBarConfig(text);
        if (patched !== text) {
          state.patchedResponses += 1;
          state.notes.push('action bar đã được thêm lựa chọn thời lượng');
          return new Response(patched, { status: response.status, statusText: response.statusText, headers: response.headers });
        }
      } else if (/\\/im\\/chain\\/single/.test(url)) {
        response.clone().text().then((body) => {
          state.chainBodies.push({ at: Date.now(), url: url.split('?')[0], body });
          if (state.chainBodies.length > 6) state.chainBodies.shift();
        }).catch(() => {});
      }
    } catch (error) {
      state.lastError = String((error && error.message) || error);
    }
    return response;
  };

  window.__dolaRunner = {
    installed: true,
    cfg: CFG,
    state,
    version: '1.0.0'
  };
  return { installed: true };
})()`;
}

module.exports = { buildPageScript };
