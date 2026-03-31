const PALETTE = {
  accent: '#d97706',
  error: '#dc2626',
  info: '#0284c7',
  success: '#059669',
} as const

function print(method: 'info' | 'warn' | 'error', scope: string, message: string, data?: unknown) {
  const color =
    method === 'error' ? PALETTE.error : method === 'warn' ? PALETTE.accent : PALETTE.info

  const prefix = `%c${scope}`
  const styles = `color:${color};font-weight:700`

  if (typeof data === 'undefined') {
    console[method](prefix, styles, message)
    return
  }

  console[method](prefix, styles, message, data)
}

export function createLogger(scope: string) {
  return {
    info(message: string, data?: unknown) {
      print('info', scope, message, data)
    },
    warn(message: string, data?: unknown) {
      print('warn', scope, message, data)
    },
    error(message: string, data?: unknown) {
      print('error', scope, message, data)
    },
    success(message: string, data?: unknown) {
      print('info', scope, `%c${message}`, [`color:${PALETTE.success};font-weight:700`, data])
    },
  }
}
