import { mkdirSync } from 'node:fs'

import { chromium, type BrowserContext, type Locator, type Page } from 'playwright-core'

import type {
  AppSettings,
  BrowserStatus,
  DispatchResult,
  DouyinClient,
  FriendRecord,
  IdentityCheckRequest,
  IdentityCheckResult,
  ProbeResult,
  SendRequest,
} from '../types.js'
import {
  avatarSignature,
  cleanConversationName,
  conversationHeaderMatches,
  friendIdentity,
  normalizeMessageText,
} from './friend-utils.js'
import { friendlyBrowserError, networkAccessIsDisabled } from './errors.js'

const CHAT_URL = 'https://www.douyin.com/chat'
const SEARCH_INPUT = 'input.semi-input[placeholder="搜索"][type="text"], input.semi-input[placeholder="搜索"]'
const SEARCH_RESULT = '.SearchPanelitembox'
const CHAT_EDITOR =
  '.messageEditorimChatEditorContainer [data-slate-editor="true"][contenteditable="true"], div[data-slate-editor="true"][contenteditable="true"]'
const CONVERSATION_LIST =
  '.conversationConversationListwrapper, [class*="conversationConversationList"], [class*="conversationList"]'
const SPARK_STATUS = '.commonStreaknormalText, [class*="streak"] [class*="text"], [class*="spark"] [class*="text"]'
const CONVERSATION_HEADER =
  '[class*="RightPanelHeadertitle"], [class*="RightPanelHeaderuser"], [class*="chatHeader"], [class*="ChatHeader"], [class*="messageHeader"], [class*="MessageHeader"], [class*="conversationTitle"], [class*="ConversationTitle"], header'

type RawConversation = { name: string; avatar: string; sparkText: string }

export class PlaywrightDouyinClient implements DouyinClient {
  readonly #profileDir: string
  readonly #settings: () => AppSettings
  #context: BrowserContext | null = null
  #page: Page | null = null
  #status: BrowserStatus = { state: 'closed', detail: '浏览器尚未启动', lastCheckedAt: null }

  constructor(profileDir: string, settings: () => AppSettings) {
    this.#profileDir = profileDir
    this.#settings = settings
    mkdirSync(profileDir, { recursive: true })
  }

  async status(): Promise<BrowserStatus> {
    if (!this.#page || this.#page.isClosed()) {
      if (this.#status.state === 'error') {
        this.#status = { ...this.#status, lastCheckedAt: new Date().toISOString() }
        return this.#status
      }
      this.#status = { state: 'closed', detail: '浏览器尚未启动', lastCheckedAt: new Date().toISOString() }
      return this.#status
    }
    const ready = await this.#isLoggedIn(this.#page, 1_500)
    if (!ready && this.#status.state === 'error') {
      this.#status = { ...this.#status, lastCheckedAt: new Date().toISOString() }
      return this.#status
    }
    this.#status = {
      state: ready ? 'ready' : 'login_required',
      detail: ready ? '聊天页已登录，可以只读扫描' : '请在打开的浏览器中完成抖音登录',
      lastCheckedAt: new Date().toISOString(),
    }
    return this.#status
  }

  async openLogin(): Promise<BrowserStatus> {
    this.#status = { state: 'opening', detail: '正在打开本机浏览器', lastCheckedAt: new Date().toISOString() }
    if (networkAccessIsDisabled()) {
      await this.#context?.close().catch(() => undefined)
      this.#context = null
      this.#page = null
      this.#status = {
        state: 'error',
        detail: '当前预览进程没有外网访问权限。请停止它，再从项目文件夹双击“启动控制面板.cmd”运行。',
        lastCheckedAt: new Date().toISOString(),
      }
      return this.#status
    }
    try {
      const page = await this.#ensurePage()
      await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await page.bringToFront()
      const ready = await this.#isLoggedIn(page, 5_000)
      this.#status = {
        state: ready ? 'ready' : 'login_required',
        detail: ready ? '已检测到登录状态' : '请手动扫码或完成短信验证；完成后返回控制面板',
        lastCheckedAt: new Date().toISOString(),
      }
    } catch (error) {
      this.#status = {
        state: 'error',
        detail: friendlyBrowserError(error, this.#settings().browserChannel),
        lastCheckedAt: new Date().toISOString(),
      }
    }
    return this.#status
  }

  async probeFriends(signal: AbortSignal): Promise<ProbeResult> {
    signal.throwIfAborted()
    const page = await this.#readyChatPage()
    const container = page.locator(CONVERSATION_LIST).first()
    await container.waitFor({ state: 'visible', timeout: 15_000 })

    const collected = new Map<string, Omit<FriendRecord, 'selected' | 'lastSeenAt'>>()
    let unchangedRounds = 0

    for (let round = 0; round < 10; round += 1) {
      signal.throwIfAborted()
      const before = collected.size
      for (const item of await this.#extractVisibleConversations(page)) {
        const name = cleanConversationName(item.name, item.sparkText)
        if (!name || !item.avatar) continue
        const id = friendIdentity(name, item.avatar)
        collected.set(id, { id, name, avatar: item.avatar, sparkText: item.sparkText })
      }

      unchangedRounds = collected.size === before ? unchangedRounds + 1 : 0
      const metrics = await container.evaluate((element) => {
        const node = element as HTMLElement
        const previous = node.scrollTop
        node.scrollTop = Math.min(previous + Math.max(node.clientHeight * 0.82, 320), node.scrollHeight)
        return { previous, current: node.scrollTop, max: node.scrollHeight - node.clientHeight }
      })
      if (metrics.current >= metrics.max - 2 || metrics.current === metrics.previous || unchangedRounds >= 2) break
      await page.waitForTimeout(550)
    }

    return { friends: [...collected.values()], scannedAt: new Date().toISOString() }
  }

  async checkConversationIdentity(request: IdentityCheckRequest): Promise<IdentityCheckResult> {
    const { friend, signal } = request
    const base = { friendId: friend.id, friendName: friend.name }
    try {
      signal.throwIfAborted()
      const page = await this.#readyChatPage()
      const result = await this.#findAndOpenConversation(page, friend, signal)
      if (!result.ok) return { ...base, verified: false, detail: result.detail }

      const verified = await this.#verifyConversationHeader(page, friend, 5_000)
      return verified
        ? { ...base, verified: true, detail: '聊天标题核验通过；未输入或发送消息' }
        : { ...base, verified: false, detail: '聊天标题无法与好友昵称及火花状态匹配' }
    } catch (error) {
      return {
        ...base,
        verified: false,
        detail: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async sendAndVerify(request: SendRequest): Promise<DispatchResult> {
    const { friend, verificationTimeoutMs, signal } = request
    const message = normalizeMessageText(request.message)
    const base = { friendId: friend.id, friendName: friend.name, message }

    try {
      signal.throwIfAborted()
      const page = await this.#readyChatPage()
      const opened = await this.#findAndOpenConversation(page, friend, signal)
      if (!opened.ok) {
        return { ...base, state: 'failed', detail: opened.detail }
      }

      if (!(await this.#verifyConversationHeader(page, friend, 5_000))) {
        return { ...base, state: 'failed', detail: '打开会话后无法二次核对聊天标题，已安全停止' }
      }

      const sparkBefore = await this.#readSparkText(page)
      if (await this.#messageExists(page, message)) {
        return {
          ...base,
          state: 'delivery_verified',
          detail: '聊天记录中已存在今天的相同消息，未重复发送',
          ...(sparkBefore ? { sparkBefore, sparkAfter: sparkBefore } : {}),
        }
      }

      const editor = page.locator(CHAT_EDITOR).first()
      await editor.waitFor({ state: 'visible', timeout: 12_000 })
      await editor.click()
      await page.keyboard.press('Control+A')
      await page.keyboard.press('Backspace')
      await page.keyboard.insertText(request.message)

      signal.throwIfAborted()
      if (!(await this.#verifyConversationHeader(page, friend, 3_000))) {
        await page.keyboard.press('Control+A')
        await page.keyboard.press('Backspace')
        return { ...base, state: 'failed', detail: '发送前聊天标题发生变化，已清空输入并停止' }
      }

      await page.keyboard.press('Enter')
      const delivered = await this.#waitForMessage(page, message, verificationTimeoutMs)
      const sparkAfter = await this.#readSparkText(page)

      if (!delivered) {
        return {
          ...base,
          state: 'delivery_unconfirmed',
          detail: '已触发发送，但未在聊天气泡中确认；为避免重复，今天不会自动重试',
          ...(sparkBefore ? { sparkBefore } : {}),
          ...(sparkAfter ? { sparkAfter } : {}),
        }
      }

      if (sparkBefore && sparkAfter && sparkBefore !== sparkAfter) {
        return {
          ...base,
          state: 'spark_changed',
          detail: '消息气泡已确认，且火花显示发生变化',
          sparkBefore,
          sparkAfter,
        }
      }

      return {
        ...base,
        state: 'delivery_verified',
        detail: '消息气泡已确认；火花是否续上仍待对方互动或后续观察',
        ...(sparkBefore ? { sparkBefore } : {}),
        ...(sparkAfter ? { sparkAfter } : {}),
      }
    } catch (error) {
      return {
        ...base,
        state: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async close(): Promise<void> {
    await this.#context?.close().catch(() => undefined)
    this.#context = null
    this.#page = null
    this.#status = { state: 'closed', detail: '浏览器已关闭', lastCheckedAt: new Date().toISOString() }
  }

  async #ensurePage(): Promise<Page> {
    if (this.#page && !this.#page.isClosed()) return this.#page
    if (!this.#context) {
      const channel = this.#settings().browserChannel
      this.#context = await chromium.launchPersistentContext(this.#profileDir, {
        channel,
        headless: false,
        viewport: null,
        locale: 'zh-CN',
        args: ['--start-maximized'],
      })
      this.#context.on('close', () => {
        this.#context = null
        this.#page = null
      })
    }
    this.#page = this.#context.pages()[0] ?? (await this.#context.newPage())
    return this.#page
  }

  async #readyChatPage(): Promise<Page> {
    const page = await this.#ensurePage()
    if (!page.url().startsWith(CHAT_URL)) {
      await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    }
    if (!(await this.#isLoggedIn(page, 10_000))) {
      this.#status = {
        state: 'login_required',
        detail: '登录状态已失效，请手动重新登录',
        lastCheckedAt: new Date().toISOString(),
      }
      throw new Error('登录状态不可用，任务已停止')
    }
    this.#status = { state: 'ready', detail: '聊天页已登录', lastCheckedAt: new Date().toISOString() }
    return page
  }

  async #isLoggedIn(page: Page, timeout: number): Promise<boolean> {
    return page
      .locator(SEARCH_INPUT)
      .first()
      .waitFor({ state: 'visible', timeout })
      .then(() => true)
      .catch(() => false)
  }

  async #extractVisibleConversations(page: Page): Promise<RawConversation[]> {
    return page.evaluate(() => {
      const scope =
        document.querySelector('.conversationConversationListwrapper, [class*="conversationConversationList"], [class*="conversationList"]') ??
        document.body
      const itemSelector =
        '[class*="conversationConversationItem"], [class*="ConversationItem"], [data-e2e="chat-item"]'
      const nodes = [...scope.querySelectorAll<HTMLElement>(itemSelector)]
      const outer = nodes.filter((node) => !node.parentElement?.closest(itemSelector))
      return outer.flatMap((node) => {
        const rect = node.getBoundingClientRect()
        if (rect.width < 40 || rect.height < 30) return []
        const titleNode = node.querySelector<HTMLElement>(
          '[class*="title"], [class*="name"], [class*="nickname"]',
        )
        const avatarNode = node.querySelector<HTMLImageElement>('img[class*="avatar"], img[class*="Avatar"], img')
        const sparkNode = node.querySelector<HTMLElement>(
          '.commonStreaknormalText, [class*="fire"], [class*="spark"], [class*="streak"]',
        )
        const nameClone = titleNode?.cloneNode(true) as HTMLElement | undefined
        for (const metadata of nameClone?.querySelectorAll<HTMLElement>(
          '.commonStreaknormalText, [class*="fire"], [class*="spark"], [class*="streak"]',
        ) ?? []) {
          metadata.remove()
        }
        const name = (nameClone?.innerText || nameClone?.textContent || titleNode?.innerText || titleNode?.textContent || '').trim()
        const avatar = avatarNode?.currentSrc || avatarNode?.src || ''
        const sparkText = (sparkNode?.innerText || sparkNode?.textContent || '').trim()
        return name && avatar ? [{ name, avatar, sparkText }] : []
      })
    })
  }

  async #uniqueSearchResult(page: Page, friend: FriendRecord): Promise<Locator | null> {
    const results = page.locator(SEARCH_RESULT).filter({ has: page.getByText(friend.name, { exact: true }) })
    await results.first().waitFor({ state: 'visible', timeout: 8_000 }).catch(() => undefined)
    const count = await results.count()
    if (count === 0) return null

    const visible: Locator[] = []
    for (let index = 0; index < count; index += 1) {
      const result = results.nth(index)
      if (await result.isVisible().catch(() => false)) visible.push(result)
    }
    if (visible.length === 1) return visible[0] ?? null

    const expectedAvatar = avatarSignature(friend.avatar)
    if (!expectedAvatar) return null
    const avatarMatches: Locator[] = []
    for (const result of visible) {
      const src = await result.locator('img').first().getAttribute('src').catch(() => null)
      if (src && avatarSignature(src) === expectedAvatar) avatarMatches.push(result)
    }
    return avatarMatches.length === 1 ? (avatarMatches[0] ?? null) : null
  }

  async #findAndOpenConversation(
    page: Page,
    friend: FriendRecord,
    signal: AbortSignal,
  ): Promise<{ ok: true } | { ok: false; detail: string }> {
    const searchInput = page.locator(SEARCH_INPUT).first()
    await searchInput.waitFor({ state: 'visible', timeout: 15_000 })
    await searchInput.fill('')
    await page.waitForTimeout(300)
    await searchInput.fill(friend.name)

    const result = await this.#uniqueSearchResult(page, friend)
    if (!result) return { ok: false, detail: '没有找到唯一且可核对的好友搜索结果' }

    signal.throwIfAborted()
    const openChat = result.getByText(/^(发消息|发私信)$/).first()
    await openChat.waitFor({ state: 'visible', timeout: 8_000 })
    await openChat.click()
    return { ok: true }
  }

  async #verifyConversationHeader(
    page: Page,
    friend: FriendRecord,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    const candidates = page.locator(CONVERSATION_HEADER)
    do {
      const texts: string[] = []
      const count = await candidates.count()
      for (let index = 0; index < count; index += 1) {
        const candidate = candidates.nth(index)
        if (!(await candidate.isVisible().catch(() => false))) continue
        const text = await candidate.innerText().catch(() => '')
        if (text) texts.push(text)
      }
      if (conversationHeaderMatches(texts, friend.name, friend.sparkText)) return true
      await page.waitForTimeout(250)
    } while (Date.now() < deadline)
    return false
  }

  async #messageExists(page: Page, message: string): Promise<boolean> {
    const normalized = normalizeMessageText(message)
    return page.evaluate(
      ({ expected }) => {
        const selectors = [
          '[class*="messageItem"]',
          '[class*="MessageItem"]',
          '[data-e2e*="message"]',
          '[class*="messageContent"]',
        ]
        return [...document.querySelectorAll<HTMLElement>(selectors.join(','))].some((node) => {
          if (node.closest('[contenteditable="true"]')) return false
          const text = (node.innerText || node.textContent || '').replace(/\u200b/g, '').replace(/\s+/g, ' ').trim()
          return text === expected
        })
      },
      { expected: normalized },
    )
  }

  async #waitForMessage(page: Page, message: string, timeout: number): Promise<boolean> {
    const normalized = normalizeMessageText(message)
    return page
      .waitForFunction(
        ({ expected }) => {
          const selectors = [
            '[class*="messageItem"]',
            '[class*="MessageItem"]',
            '[data-e2e*="message"]',
            '[class*="messageContent"]',
          ]
          return [...document.querySelectorAll<HTMLElement>(selectors.join(','))].some((node) => {
            if (node.closest('[contenteditable="true"]')) return false
            const text = (node.innerText || node.textContent || '').replace(/\u200b/g, '').replace(/\s+/g, ' ').trim()
            return text === expected
          })
        },
        { expected: normalized },
        { timeout },
      )
      .then(() => true)
      .catch(() => false)
  }

  async #readSparkText(page: Page): Promise<string> {
    const items = page.locator(SPARK_STATUS)
    const count = await items.count()
    for (let index = 0; index < count; index += 1) {
      const item = items.nth(index)
      if (!(await item.isVisible().catch(() => false))) continue
      const text = normalizeMessageText(await item.innerText().catch(() => ''))
      if (text) return text
    }
    return ''
  }

}
