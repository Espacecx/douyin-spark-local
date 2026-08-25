const state = {
  settings: null,
  friends: [],
  runs: [],
  busy: false,
  selectedIds: new Set(),
  selectionDirty: false,
  pendingRiskPhrase: '',
}

const elements = Object.fromEntries(
  [
    'global-state', 'browser-state', 'browser-detail', 'sending-state', 'schedule-state',
    'schedule-detail', 'selected-count', 'friend-count', 'friend-list', 'friend-search',
    'save-selection-btn', 'login-btn', 'probe-btn', 'settings-form', 'browser-channel',
    'message-template', 'schedule-time', 'max-targets', 'verification-timeout',
    'schedule-enabled', 'sending-enabled', 'preview-btn', 'identity-check-btn', 'execute-btn', 'stop-btn',
    'run-list', 'risk-dialog', 'risk-form', 'risk-phrase', 'risk-confirm-btn',
    'send-dialog', 'send-form', 'send-confirm-btn', 'toast',
  ].map((id) => [id, document.getElementById(id)]),
)

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json', ...(options.headers || {}) } : options.headers,
  })
  const data = await response.json()
  if (!response.ok || data.ok === false) throw new Error(data.error || '操作失败')
  return data
}

function toast(message, type = 'normal') {
  elements.toast.textContent = message
  elements.toast.className = `toast show ${type === 'error' ? 'error' : ''}`
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => { elements.toast.className = 'toast' }, 3200)
}

function setBusy(busy, label = '') {
  state.busy = busy
  for (const id of ['login-btn', 'probe-btn', 'preview-btn', 'identity-check-btn', 'execute-btn', 'save-selection-btn']) {
    elements[id].disabled = busy
  }
  elements['global-state'].textContent = busy ? label || '处理中' : '本机运行'
  elements['global-state'].className = `global-state ${busy ? 'busy' : 'good'}`
}

async function refreshAll({ fillForm = false } = {}) {
  const [statusData, friendsData, runsData] = await Promise.all([
    api('/api/status'), api('/api/friends'), api('/api/runs'),
  ])
  state.settings = statusData.settings
  state.friends = friendsData.friends
  state.runs = runsData.runs
  if (!state.selectionDirty) {
    state.selectedIds = new Set(state.friends.filter((friend) => friend.selected).map((friend) => friend.id))
  }
  renderStatus(statusData)
  renderFriends()
  renderRuns()
  if (fillForm) fillSettingsForm()
}

function renderStatus(data) {
  const labels = {
    closed: '未启动', opening: '正在打开', login_required: '需要登录', ready: '已就绪', error: '异常',
  }
  elements['browser-state'].textContent = labels[data.browser.state] || data.browser.state
  elements['browser-detail'].textContent = data.browser.detail
  elements['sending-state'].textContent = data.settings.sendingEnabled ? '已允许' : '已关闭'
  elements['sending-state'].className = data.settings.sendingEnabled ? 'enabled' : ''
  elements['schedule-state'].textContent = data.scheduler.armed ? '已布防' : data.scheduler.enabled ? '等待发送授权' : '未启用'
  elements['schedule-detail'].textContent = `每天 ${data.scheduler.scheduleTime}`
  elements['selected-count'].textContent = String(data.selectedCount)
  elements['friend-count'].textContent = `共扫描到 ${data.friendCount} 位`
  if (data.runner.busy) {
    elements['global-state'].textContent = data.runner.operation === 'probing' ? '正在扫描' : '正在运行'
    elements['global-state'].className = 'global-state busy'
  } else if (data.browser.state === 'error') {
    elements['global-state'].textContent = '需要处理'
    elements['global-state'].className = 'global-state error'
  } else {
    elements['global-state'].textContent = '本机运行'
    elements['global-state'].className = 'global-state good'
  }
}

function fillSettingsForm() {
  if (!state.settings) return
  elements['browser-channel'].value = state.settings.browserChannel
  elements['message-template'].value = state.settings.messageTemplate
  elements['schedule-time'].value = state.settings.scheduleTime
  elements['max-targets'].value = state.settings.maxTargetsPerRun
  elements['verification-timeout'].value = Math.round(state.settings.verificationTimeoutMs / 1000)
  elements['schedule-enabled'].checked = state.settings.scheduleEnabled
  elements['sending-enabled'].checked = state.settings.sendingEnabled
}

function renderFriends() {
  const query = elements['friend-search'].value.trim().toLocaleLowerCase('zh-CN')
  const filtered = state.friends.filter((friend) => friend.name.toLocaleLowerCase('zh-CN').includes(query))
  const counts = state.friends.reduce((map, friend) => map.set(friend.name, (map.get(friend.name) || 0) + 1), new Map())
  if (!filtered.length) {
    elements['friend-list'].innerHTML = `
      <div class="empty-state"><span>◎</span><strong>${state.friends.length ? '没有匹配的好友' : '还没有好友数据'}</strong>
      <p>${state.friends.length ? '换一个关键词试试。' : '先打开登录页，再执行只读扫描。扫描不会发送消息。'}</p></div>`
    return
  }
  elements['friend-list'].innerHTML = filtered.map((friend) => {
    const duplicate = counts.get(friend.name) > 1
    return `<label class="friend-card ${duplicate ? 'duplicate' : ''}">
      <img class="avatar" src="${escapeAttribute(friend.avatar)}" alt="" referrerpolicy="no-referrer" />
      <span class="friend-meta"><strong>${escapeHtml(friend.name)}</strong>
        <small class="${duplicate ? 'duplicate-note' : ''}">${duplicate ? '存在同名好友，请设置唯一备注' : escapeHtml(friend.sparkText || '未读取到火花状态')}</small>
      </span>
      <input type="checkbox" data-friend-id="${escapeAttribute(friend.id)}" ${state.selectedIds.has(friend.id) ? 'checked' : ''} ${duplicate ? 'disabled' : ''} />
    </label>`
  }).join('')
}

function renderRuns() {
  if (!state.runs.length) {
    elements['run-list'].innerHTML = '<div class="empty-inline">暂无运行记录</div>'
    return
  }
  const modeLabels = { preview: '预览', manual: '手动', scheduled: '定时' }
  const stateLabels = {
    preview: '预览', skipped_already_verified: '今日已跳过', skipped_ambiguous_name: '同名已跳过',
    delivery_verified: '消息已确认', delivery_unconfirmed: '发送待确认', spark_changed: '火花有变化', failed: '失败',
  }
  elements['run-list'].innerHTML = state.runs.map((run) => `
    <article class="run-item">
      <div class="run-summary">
        <span class="run-badge ${run.status}">${modeLabels[run.mode]} · ${run.status}</span>
        <div><strong>${escapeHtml(run.summary || '任务运行中')}</strong><br /><small>${formatTime(run.startedAt)}</small></div>
        <small>${run.dispatches?.length || 0} 个目标</small>
      </div>
      ${run.dispatches?.length ? `<div class="dispatch-list">${run.dispatches.map((item) => `
        <div class="dispatch"><strong>${escapeHtml(item.friendName)} · ${stateLabels[item.state] || item.state}</strong><span>${escapeHtml(item.detail)}<br />“${escapeHtml(item.message)}”</span></div>
      `).join('')}</div>` : ''}
    </article>`).join('')
}

async function saveSettings(riskPhrase = '') {
  const payload = {
    browserChannel: elements['browser-channel'].value,
    messageTemplate: elements['message-template'].value,
    scheduleTime: elements['schedule-time'].value,
    maxTargetsPerRun: Number(elements['max-targets'].value),
    verificationTimeoutMs: Number(elements['verification-timeout'].value) * 1000,
    scheduleEnabled: elements['schedule-enabled'].checked,
    sendingEnabled: elements['sending-enabled'].checked,
    ...(riskPhrase ? { riskAcknowledgement: riskPhrase } : {}),
  }
  const data = await api('/api/settings', { method: 'PUT', body: JSON.stringify(payload) })
  state.settings = data.settings
  fillSettingsForm()
  toast('规则已保存在本机')
  await refreshAll()
}

elements['settings-form'].addEventListener('submit', async (event) => {
  event.preventDefault()
  const enablingForFirstTime = elements['sending-enabled'].checked && !state.settings?.riskAcknowledged
  if (enablingForFirstTime) {
    elements['risk-phrase'].value = ''
    elements['risk-dialog'].showModal()
    return
  }
  try { await saveSettings() } catch (error) { toast(error.message, 'error') }
})

elements['risk-confirm-btn'].addEventListener('click', async (event) => {
  event.preventDefault()
  try {
    await saveSettings(elements['risk-phrase'].value.trim())
    elements['risk-dialog'].close()
  } catch (error) { toast(error.message, 'error') }
})

elements['login-btn'].addEventListener('click', async () => {
  setBusy(true, '正在打开浏览器')
  try {
    const data = await api('/api/browser/login', { method: 'POST' })
    toast(data.browser.detail)
    await refreshAll()
  } catch (error) { toast(error.message, 'error') } finally { setBusy(false) }
})

elements['probe-btn'].addEventListener('click', async () => {
  setBusy(true, '正在只读扫描')
  try {
    const data = await api('/api/probe', { method: 'POST' })
    state.selectionDirty = false
    toast(`扫描完成：发现 ${data.friends.length} 位好友`)
    await refreshAll()
  } catch (error) { toast(error.message, 'error') } finally { setBusy(false) }
})

elements['save-selection-btn'].addEventListener('click', async () => {
  const selectedIds = [...state.selectedIds]
  try {
    await api('/api/friends/selection', { method: 'PUT', body: JSON.stringify({ selectedIds }) })
    state.selectionDirty = false
    toast(`已保存 ${selectedIds.length} 位好友`)
    await refreshAll()
  } catch (error) { toast(error.message, 'error') }
})

elements['friend-search'].addEventListener('input', renderFriends)
elements['friend-list'].addEventListener('change', (event) => {
  const input = event.target.closest('[data-friend-id]')
  if (!input) return
  if (input.checked) state.selectedIds.add(input.dataset.friendId)
  else state.selectedIds.delete(input.dataset.friendId)
  state.selectionDirty = true
  elements['selected-count'].textContent = String(state.selectedIds.size)
})

elements['preview-btn'].addEventListener('click', async () => {
  setBusy(true, '正在生成预览')
  try {
    await api('/api/run/preview', { method: 'POST' })
    toast('预览已生成，没有发送任何消息')
    await refreshAll()
  } catch (error) { toast(error.message, 'error') } finally { setBusy(false) }
})

elements['identity-check-btn'].addEventListener('click', async () => {
  setBusy(true, '正在安全核验')
  try {
    const data = await api('/api/run/identity-check', { method: 'POST' })
    const passed = data.results.filter((item) => item.verified).length
    const failed = data.results.filter((item) => !item.verified)
    if (failed.length) {
      toast(`核验通过 ${passed}，失败 ${failed.length}：${failed[0].detail}`, 'error')
    } else {
      toast(`身份核验通过 ${passed} 位；没有输入或发送消息`)
    }
    await refreshAll()
  } catch (error) { toast(error.message, 'error') } finally { setBusy(false) }
})

elements['execute-btn'].addEventListener('click', () => elements['send-dialog'].showModal())
elements['send-confirm-btn'].addEventListener('click', async (event) => {
  event.preventDefault()
  elements['send-dialog'].close()
  setBusy(true, '正在运行')
  try {
    await api('/api/run/execute', { method: 'POST' })
    toast('运行结束，请查看逐好友结果')
    await refreshAll()
  } catch (error) { toast(error.message, 'error') } finally { setBusy(false) }
})

elements['stop-btn'].addEventListener('click', async () => {
  try {
    const data = await api('/api/run/stop', { method: 'POST' })
    toast(data.stopped ? '已发出停止信号' : '当前没有运行中的任务')
  } catch (error) { toast(error.message, 'error') }
})

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char])
}
function escapeAttribute(value) { return escapeHtml(value) }
function formatTime(value) { return new Date(value).toLocaleString('zh-CN', { hour12: false }) }

refreshAll({ fillForm: true }).catch((error) => toast(error.message, 'error'))
setInterval(() => {
  if (!state.busy && !document.hidden) refreshAll().catch(() => undefined)
}, 5000)
