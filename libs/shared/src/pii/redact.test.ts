import { describe, it, expect } from 'vitest';
import {
  redactText,
  redactDeep,
  isValidCpf,
  isValidCnpj,
  isValidCardNumber,
  isValidIpv4,
  isValidBrPhone,
  SAUDE_RULES,
  DEFAULT_PII_RULES,
} from './redact';

describe('validators', () => {
  it('validates CPF check digits and rejects repeated sequences', () => {
    expect(isValidCpf('529.982.247-25')).toBe(true);
    expect(isValidCpf('52998224725')).toBe(true);
    expect(isValidCpf('529.982.247-26')).toBe(false);
    expect(isValidCpf('111.111.111-11')).toBe(false);
  });

  it('validates CNPJ check digits and rejects repeated sequences', () => {
    expect(isValidCnpj('11.222.333/0001-81')).toBe(true);
    expect(isValidCnpj('11222333000181')).toBe(true);
    expect(isValidCnpj('11.222.333/0001-82')).toBe(false);
    expect(isValidCnpj('00000000000000')).toBe(false);
  });

  it('validates card numbers with Luhn', () => {
    expect(isValidCardNumber('4111 1111 1111 1111')).toBe(true);
    expect(isValidCardNumber('5555-5555-5555-4444')).toBe(true);
    expect(isValidCardNumber('4111 1111 1111 1112')).toBe(false);
    expect(isValidCardNumber('1729200000000')).toBe(false);
  });

  it('validates IPv4 octet range', () => {
    expect(isValidIpv4('192.168.0.1')).toBe(true);
    expect(isValidIpv4('256.1.1.1')).toBe(false);
  });

  it('validates BR phones by DDD and shape', () => {
    expect(isValidBrPhone('(11) 98765-4321')).toBe(true);
    expect(isValidBrPhone('+55 11 98765-4321')).toBe(true);
    expect(isValidBrPhone('11987654321')).toBe(true);
    expect(isValidBrPhone('(11) 3333-4444')).toBe(true);
    expect(isValidBrPhone('(10) 98765-4321')).toBe(false);
    expect(isValidBrPhone('1133334444')).toBe(false);
    expect(isValidBrPhone('1729200000')).toBe(false);
  });
});

describe('redactText', () => {
  it('replaces CPF and discards the original', () => {
    const out = redactText('Meu CPF é 529.982.247-25, obrigado');
    expect(out).toBe('Meu CPF é [CPF], obrigado');
    expect(out).not.toContain('529');
  });

  it('replaces unformatted CPF and CNPJ', () => {
    expect(redactText('cpf 52998224725')).toBe('cpf [CPF]');
    expect(redactText('cnpj 11.222.333/0001-81')).toBe('cnpj [CNPJ]');
    expect(redactText('cnpj 11222333000181')).toBe('cnpj [CNPJ]');
  });

  it('keeps digit runs that fail validation', () => {
    expect(redactText('pedido 529.982.247-26')).toBe('pedido 529.982.247-26');
    expect(redactText('timestamp 1729200000000')).toBe('timestamp 1729200000000');
  });

  it('replaces e-mail, card, IP, phone and tokens', () => {
    expect(redactText('mail ana.souza+x@exemplo.com.br')).toBe('mail [EMAIL]');
    expect(redactText('cartao 4111 1111 1111 1111')).toBe('cartao [CARTAO]');
    expect(redactText('ip 10.0.0.255.')).toBe('ip [IP].');
    expect(redactText('tel (11) 98765-4321')).toBe('tel [TELEFONE]');
    expect(redactText('key sk-abcdefghijklmnop1234')).toBe('key [TOKEN]');
    expect(redactText('id AKIAABCDEFGHIJKLMNOP')).toBe('id [TOKEN]');
    expect(redactText(`pat ghp_${'a'.repeat(36)}`)).toBe('pat [TOKEN]');
    expect(redactText('Authorization: Bearer abcdefghijklmnopqrstuv')).toBe('Authorization: Bearer [TOKEN]');
  });

  it('does not touch invalid IPs', () => {
    expect(redactText('v 300.1.1.1')).toBe('v 300.1.1.1');
  });

  it('applies CPF/CNPJ/card before phone (no partial phone matches inside them)', () => {
    expect(redactText('11987654321 and 52998224725')).toBe('[TELEFONE] and [CPF]');
    expect(redactText('4111111111111111')).toBe('[CARTAO]');
  });

  it('is idempotent', () => {
    const once = redactText('cpf 529.982.247-25 mail a@b.com ip 1.2.3.4');
    expect(redactText(once)).toBe(once);
  });

  it('returns empty input untouched', () => {
    expect(redactText('')).toBe('');
  });

  it('applies custom patterns as [REDACTED] by default', () => {
    const out = redactText('processo PRC-123456', { extraPatterns: [{ pattern: /PRC-\d+/ }] });
    expect(out).toBe('processo [REDACTED]');
    const custom = redactText('processo PRC-1', { extraPatterns: [{ pattern: /PRC-\d+/g, placeholder: '[PROC]' }] });
    expect(custom).toBe('processo [PROC]');
  });
});

describe('redactDeep', () => {
  it('redacts strings in nested objects and arrays without mutating the input', () => {
    const input = {
      a: 'cpf 529.982.247-25',
      n: 42,
      ok: true,
      nested: { list: ['x@y.com', { deep: 'ip 8.8.8.8' }], none: null },
    };
    const snapshot = JSON.stringify(input);
    const out = redactDeep(input);
    expect(out).toEqual({
      a: 'cpf [CPF]',
      n: 42,
      ok: true,
      nested: { list: ['[EMAIL]', { deep: 'ip [IP]' }], none: null },
    });
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('handles circular references without throwing', () => {
    const a: Record<string, unknown> = { v: 'a@b.com' };
    a.self = a;
    const out = redactDeep(a) as Record<string, unknown>;
    expect(out.v).toBe('[EMAIL]');
    expect(out.self).toBe('[TRUNCADO]');
  });

  it('leaves non-plain objects such as Date untouched', () => {
    const d = new Date(0);
    expect((redactDeep({ d }) as { d: Date }).d).toBe(d);
  });
});

describe('rule set', () => {
  it('reserves an empty health category', () => {
    expect(SAUDE_RULES).toHaveLength(0);
    expect(DEFAULT_PII_RULES.some((r) => r.category === 'saude')).toBe(false);
  });
});
