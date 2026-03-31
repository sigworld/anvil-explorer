import { useEffect, useState } from 'preact/hooks'

type AsyncState<T> = {
  data: T
  error: string | null
  loadedOnce: boolean
  loading: boolean
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true
  }

  if (typeof left === 'bigint' || typeof right === 'bigint') {
    return String(left) === String(right)
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => isEqual(item, right[index]))
  }

  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)

    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => key in right && isEqual(left[key], right[key]))
    )
  }

  return false
}

export function useAsyncResource<T>(factory: () => Promise<T>, deps: unknown[], initial: T) {
  const [state, setState] = useState<AsyncState<T>>({
    data: initial,
    error: null,
    loadedOnce: false,
    loading: true,
  })

  useEffect(() => {
    let active = true

    setState((current) => ({
      ...(current.loading === !current.loadedOnce && current.error === null
        ? current
        : {
            ...current,
            loading: !current.loadedOnce,
            error: null,
          }),
    }))

    factory()
      .then((data) => {
        if (!active) {
          return
        }

        setState((current) => {
          const nextState: AsyncState<T> = {
            data: isEqual(current.data, data) ? current.data : data,
            error: null,
            loadedOnce: true,
            loading: false,
          }

          if (
            nextState.data === current.data &&
            nextState.error === current.error &&
            nextState.loadedOnce === current.loadedOnce &&
            nextState.loading === current.loading
          ) {
            return current
          }

          return nextState
        })
      })
      .catch((error: unknown) => {
        if (!active) {
          return
        }

        setState((current) => ({
          ...(current.error === (error instanceof Error ? error.message : 'Unknown error') &&
          current.loadedOnce &&
          !current.loading
            ? current
            : {
                data: current.data,
                error: error instanceof Error ? error.message : 'Unknown error',
                loadedOnce: true,
                loading: false,
              }),
        }))
      })

    return () => {
      active = false
    }
  }, deps)

  return state
}
