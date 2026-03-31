import { getAddress, type Hex } from 'viem'
import { getErc20BalanceAtBlock, getErc20TokenInfo, type AnvilClient } from './rpc.ts'
import type { LogRecord, TokenBalanceEffect } from './types.ts'

const ERC20_TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

function topicToAddress(topic: Hex | undefined) {
  if (!topic || topic.length !== 66) {
    return null
  }

  return getAddress(`0x${topic.slice(-40)}`)
}

function hexDataToBigInt(data: Hex) {
  return BigInt(data)
}

type AggregatedEffect = {
  tokenAddress: Hex
  holderAddress: Hex
  delta: bigint
  blockNumber: number | null
}

export async function buildTokenBalanceEffects(
  client: AnvilClient,
  logs: LogRecord[],
  blockNumber: number | null,
) {
  const aggregated = new Map<string, AggregatedEffect>()

  for (const log of logs) {
    if (log.topic0 !== ERC20_TRANSFER_TOPIC) {
      continue
    }

    const fromAddress = topicToAddress(log.topics[1])
    const toAddress = topicToAddress(log.topics[2])
    const amount = hexDataToBigInt(log.data)

    const applyDelta = (holderAddress: Hex | null, delta: bigint) => {
      if (!holderAddress || holderAddress === ZERO_ADDRESS) {
        return
      }

      const key = `${log.address}:${holderAddress}`
      const current = aggregated.get(key)

      aggregated.set(key, {
        tokenAddress: log.address,
        holderAddress,
        delta: (current?.delta ?? 0n) + delta,
        blockNumber: log.blockNumber,
      })
    }

    applyDelta(fromAddress, -amount)
    applyDelta(toAddress, amount)
  }

  const meaningfulEffects = [...aggregated.values()].filter((effect) => effect.delta !== 0n)

  return (
    await Promise.all(
      meaningfulEffects.map(async (effect): Promise<TokenBalanceEffect | null> => {
        const tokenInfo = await getErc20TokenInfo(client, effect.tokenAddress)
        if (!tokenInfo) {
          return null
        }

        const afterBlockNumber = blockNumber
        const beforeBlockNumber = typeof blockNumber === 'number' ? Math.max(0, blockNumber - 1) : null

        const [beforeBalance, afterBalance] = await Promise.all([
          beforeBlockNumber === null
            ? Promise.resolve(null)
            : getErc20BalanceAtBlock(client, effect.tokenAddress, effect.holderAddress, beforeBlockNumber),
          afterBlockNumber === null
            ? Promise.resolve(null)
            : getErc20BalanceAtBlock(client, effect.tokenAddress, effect.holderAddress, afterBlockNumber),
        ])

        return {
          tokenAddress: effect.tokenAddress,
          holderAddress: effect.holderAddress,
          decimals: tokenInfo.decimals,
          symbol: tokenInfo.symbol,
          name: tokenInfo.name,
          beforeBalance,
          afterBalance,
          delta: effect.delta.toString(),
          blockNumber: effect.blockNumber,
        }
      }),
    )
  )
    .filter((item): item is TokenBalanceEffect => item !== null)
    .sort((left, right) => {
      const magnitude = (value: string) => {
        const bigint = BigInt(value)
        return bigint < 0n ? -bigint : bigint
      }

      const deltaDifference = magnitude(right.delta) - magnitude(left.delta)
      if (deltaDifference !== 0n) {
        return deltaDifference > 0n ? 1 : -1
      }

      return (right.blockNumber ?? -1) - (left.blockNumber ?? -1)
    })
}
