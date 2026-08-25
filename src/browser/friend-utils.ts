import { createHash } from 'node:crypto'

export function cleanConversationName(raw: string, sparkText = ''): string {
  let value = raw.replace(/\s+/g, ' ').trim()
  if (!value) return ''

  const normalizedSpark = sparkText.replace(/\s+/g, ' ').trim()
  if (normalizedSpark) {
    const escapedSpark = escapeRegExp(normalizedSpark)
    value = value
      .replace(new RegExp(`\\s+${escapedSpark}$`, 'u'), '')
      .replace(new RegExp(`[🔥🌱🌿🍃💧🧊✨💫]+\\s*${escapedSpark}$`, 'u'), '')
      .trim()
  }

  const spacedMetadata = /\s+(?:\d+\s*)?(?:刚刚|今天|昨天|前天|周[一二三四五六日天]|\d+\s*(?:秒|分钟|小时|天)前|\d{1,2}:\d{2}|\d{1,2}\/\d{1,2}).*$/u
  value = value.replace(spacedMetadata, '').trim()

  const attachedMetadata = /(?:刚刚|今天|昨天|前天|周[一二三四五六日天]|\d+\s*(?:秒|分钟|小时|天)前|\d{1,2}:\d{2}|\d{1,2}\/\d{1,2})$/u
  value = value.replace(attachedMetadata, '').trim()

  return value.slice(0, 80)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function avatarSignature(url: string): string {
  if (!url) return ''
  try {
    const parsed = new URL(url)
    return parsed.pathname.split('/').filter(Boolean).at(-1)?.slice(0, 80) ?? ''
  } catch {
    return url.split('?')[0]?.split('/').at(-1)?.slice(0, 80) ?? ''
  }
}

export function friendIdentity(name: string, avatar: string): string {
  const stableAvatarPart = avatarSignature(avatar)
  return createHash('sha256').update(`${name}\u0000${stableAvatarPart}`).digest('hex').slice(0, 24)
}

export function normalizeMessageText(value: string): string {
  return value.replace(/\u200b/g, '').replace(/\s+/g, ' ').trim()
}

export function conversationHeaderMatches(
  visibleTexts: string[],
  expectedName: string,
  sparkText = '',
): boolean {
  const expected = normalizeMessageText(expectedName)
  return visibleTexts
    .flatMap((text) => text.split(/\r?\n/u))
    .some((line) => normalizeMessageText(cleanConversationName(line, sparkText)) === expected)
}
