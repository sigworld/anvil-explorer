import type { Hex } from 'viem'

export function shortenHex(value: string | null | undefined, size = 6) {
  if (!value) {
    return 'n/a'
  }

  if (value.length <= size * 2) {
    return value
  }

  return `${value.slice(0, size + 2)}…${value.slice(-size)}`
}

export function formatNumber(value: number | bigint | null | undefined) {
  if (typeof value === 'undefined' || value === null) {
    return 'n/a'
  }

  return Intl.NumberFormat().format(Number(value))
}

export function formatTimestamp(timestamp: number | null | undefined) {
  if (!timestamp) {
    return 'n/a'
  }

  return new Date(timestamp * 1000).toLocaleString()
}

export function formatBigIntString(value: string | null | undefined) {
  if (!value) {
    return 'n/a'
  }

  return Intl.NumberFormat().format(Number(value))
}

export function formatHexQuantity(value: Hex | null | undefined) {
  if (!value) {
    return null
  }

  return BigInt(value).toString()
}

export function formatEtherString(value: string | null | undefined) {
  if (!value) {
    return '0 ETH'
  }

  const asBigInt = BigInt(value)
  const whole = asBigInt / 10n ** 18n
  const fraction = asBigInt % 10n ** 18n

  if (fraction === 0n) {
    return `${whole.toString()} ETH`
  }

  const trimmed = fraction.toString().padStart(18, '0').replace(/0+$/, '')
  return `${whole.toString()}.${trimmed.slice(0, 6)} ETH`
}

export function formatUnitsString(
  value: string | null | undefined,
  decimals: number,
  suffix?: string | null,
) {
  if (!value) {
    return suffix ? `0 ${suffix}` : '0'
  }

  const asBigInt = BigInt(value)
  const base = 10n ** BigInt(decimals)
  const whole = asBigInt / base
  const fraction = asBigInt % base
  const trimmedFraction =
    fraction === 0n
      ? ''
      : `.${fraction.toString().padStart(decimals, '0').replace(/0+$/, '').slice(0, 6)}`

  const formatted = `${whole.toString()}${trimmedFraction}`
  return suffix ? `${formatted} ${suffix}` : formatted
}

export function parseNumberInput(value: string) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : null
}
