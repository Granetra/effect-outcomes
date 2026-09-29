import type { JsonValue } from './types.js';

/** Canonical JSON v1: sorted object keys, JSON number syntax, and exact array order. */
export function canonicalJson(value: JsonValue): string {
  const ancestors = new Set<object>();

  function encode(current: unknown): string {
    if (current === null || typeof current === 'boolean' || typeof current === 'string') {
      return JSON.stringify(current);
    }
    if (typeof current === 'number' && Number.isFinite(current)) {
      return JSON.stringify(current);
    }
    if (typeof current !== 'object' || current === null) {
      throw new TypeError('Value must contain only JSON values with finite numbers');
    }
    if (ancestors.has(current)) {
      throw new TypeError('Cyclic values are not supported');
    }
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        if (Reflect.ownKeys(current).length !== current.length + 1) {
          throw new TypeError('Arrays must be dense and have no extra properties');
        }
        const values: string[] = [];
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          if (!descriptor || !('value' in descriptor)) {
            throw new TypeError('Arrays must be dense and contain data properties');
          }
          values.push(encode(descriptor.value));
        }
        return `[${values.join(',')}]`;
      }
      const prototype: unknown = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('Objects must be plain JSON objects');
      }
      const keys = Reflect.ownKeys(current);
      if (keys.some((key) => typeof key !== 'string')) {
        throw new TypeError('Symbol keys are not supported');
      }
      const entries = (keys as string[]).sort().map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor?.enumerable || !('value' in descriptor)) {
          throw new TypeError('Objects must contain enumerable data properties');
        }
        return `${JSON.stringify(key)}:${encode(descriptor.value)}`;
      });
      return `{${entries.join(',')}}`;
    } finally {
      ancestors.delete(current);
    }
  }

  return encode(value);
}

export function copyJson(value: JsonValue): JsonValue {
  return JSON.parse(canonicalJson(value)) as JsonValue;
}

export async function fingerprintInput(input: JsonValue): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(input));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return `sha256-json-v1:${Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
