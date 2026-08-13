export type LarkEventMode = 'long-connection' | 'webhook';

export function larkEventModeValue(value?: string): LarkEventMode {
  const normalized = (value || 'long-connection').trim().toLowerCase();
  if (normalized === 'long-connection' || normalized === 'webhook') {
    return normalized;
  }
  throw new Error(
    'OPENTAG_LARK_EVENT_MODE must be long-connection or webhook.',
  );
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === '127.0.0.1' ||
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '[::1]' ||
    normalized.startsWith('127.') ||
    normalized.startsWith('::ffff:127.')
  );
}

export function assertServerStartupSecurity(input: {
  host: string;
  operatorAuthConfigured: boolean;
  larkEventMode: LarkEventMode;
  larkVerificationTokenConfigured: boolean;
  larkEncryptKeyConfigured: boolean;
}): void {
  if (!input.operatorAuthConfigured && !isLoopbackHost(input.host)) {
    throw new Error(
      'MaxTag refuses to bind a non-loopback host without operator authentication. Set OPENTAG_ADMIN_TOKEN or OPENTAG_OPERATOR_PRINCIPALS_JSON.',
    );
  }
  if (
    input.larkEventMode === 'webhook' &&
    !input.larkVerificationTokenConfigured &&
    !input.larkEncryptKeyConfigured
  ) {
    throw new Error(
      'Lark webhook mode requires OPENTAG_LARK_VERIFICATION_TOKEN or OPENTAG_LARK_ENCRYPT_KEY.',
    );
  }
}
