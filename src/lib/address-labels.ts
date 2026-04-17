const EVM_PRECOMPILE_LABELS: Record<string, string> = {
  '0x0000000000000000000000000000000000000001': 'ecrecover',
  '0x0000000000000000000000000000000000000002': 'SHA-256',
  '0x0000000000000000000000000000000000000003': 'RIPEMD-160',
  '0x0000000000000000000000000000000000000004': 'identity',
  '0x0000000000000000000000000000000000000005': 'modexp',
  '0x0000000000000000000000000000000000000006': 'ecAdd',
  '0x0000000000000000000000000000000000000007': 'ecMul',
  '0x0000000000000000000000000000000000000008': 'ecPairing',
  '0x0000000000000000000000000000000000000009': 'blake2f',
  '0x000000000000000000000000000000000000000a': 'pointEvaluation',
}

export function isPrecompileAddress(address: string | null | undefined): boolean {
  if (!address) {
    return false
  }

  return address.toLowerCase() in EVM_PRECOMPILE_LABELS
}

const ANVIL_ACCOUNT_LABELS: Record<string, string> = {
  '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266': 'Anvil Account 0 (Deployer)',
  '0x70997970c51812dc3a010c7d01b50e0d17dc79c8': 'Anvil Account 1',
  '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc': 'Anvil Account 2',
  '0x90f79bf6eb2c4f870365e785982e1f101e93b906': 'Anvil Account 3',
  '0x15d34aaf54267db7d7c367839aaf71a00a2c6a65': 'Anvil Account 4',
  '0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc': 'Anvil Account 5',
  '0x976ea74026e726554db657fa54763abd0c3a0aa9': 'Anvil Account 6',
  '0x14dc79964da2c08b23698b3d3cc7ca32193d9955': 'Anvil Account 7',
  '0x23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f': 'Anvil Account 8',
  '0xa0ee7a142d267c1f36714e4a8f75612f20a79720': 'Anvil Account 9',
  '0xbcd4042de499d14e55001ccbb24a551f3b954096': 'Anvil Account 10',
  '0x71be63f3384f5fb98995898a86b02fb2426c5788': 'Anvil Account 11',
  '0xfabb0ac9d68b0b445fb7357272ff202c5651694a': 'Anvil Account 12',
  '0x1cbd3b2770909d4e10f157cabc84c7264073c9ec': 'Anvil Account 13',
  '0xdf3e18d64bc6a983f673ab319ccae4f1a57c7097': 'Anvil Account 14',
}

export function getDefaultAddressLabel(address: string | null | undefined) {
  if (!address) {
    return null
  }

  const lower = address.toLowerCase()
  return EVM_PRECOMPILE_LABELS[lower] ?? ANVIL_ACCOUNT_LABELS[lower] ?? null
}
