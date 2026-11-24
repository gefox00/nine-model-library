'use strict';

// Deliberately parses literal Customizer headers, never OpenSCAD expressions.
// Reference: https://files.openscad.org/documentation/manual/Customizer.html
const LIMITS = Object.freeze({ source: 4 * 1024 * 1024, tokens: 200_000, parameters: 256, options: 128, string: 4096, vector: 64, magnitude: 1e12, defineChars: 8192 });
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor', 'true', 'false', 'undef', 'module', 'function', 'include', 'use', 'if', 'else', 'for', 'intersection_for', 'let', 'each', 'assert', 'echo']);
const TYPES = new Set(['number', 'boolean', 'string', 'vector']);
const NUMBER = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const sameValue = (a, b) => Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((value, index) => value === b[index]) : a === b;
const safeName = (name) => typeof name === 'string' && IDENTIFIER.test(name) && !FORBIDDEN.has(name);

function fail(message) { throw new Error(message); }

function validString(value) {
  if (typeof value !== 'string' || value.length > LIMITS.string || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function safeNumber(value) { return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= LIMITS.magnitude; }

function tokenize(source) {
  const tokens = [];
  let offset = 0, line = 1;
  const push = (type, start, startLine, value) => {
    if (tokens.length >= LIMITS.tokens) fail('SCADのパラメータ解析対象が大きすぎます');
    tokens.push({ type, value, line: startLine, endLine: line, start, end: offset });
  };
  while (offset < source.length) {
    const char = source[offset];
    if (/\s/.test(char)) { if (char === '\n') line++; offset++; continue; }
    const start = offset, startLine = line;
    if (char === '/' && source[offset + 1] === '/') {
      offset += 2;
      while (offset < source.length && source[offset] !== '\n') offset++;
      push('line-comment', start, startLine, source.slice(start + 2, offset));
    } else if (char === '/' && source[offset + 1] === '*') {
      offset += 2;
      while (offset < source.length && !(source[offset] === '*' && source[offset + 1] === '/')) { if (source[offset] === '\n') line++; offset++; }
      if (offset >= source.length) { push('invalid', start, startLine, ''); break; }
      const value = source.slice(start + 2, offset);
      offset += 2;
      push('block-comment', start, startLine, value);
    } else if (char === '"') {
      offset++;
      let closed = false;
      while (offset < source.length) {
        if (source[offset] === '\n') line++;
        if (source[offset] === '\\') {
          if (source[offset + 1] === '\n') line++;
          offset += 2;
        } else if (source[offset++] === '"') { closed = true; break; }
      }
      push(closed ? 'string' : 'invalid', start, startLine, source.slice(start, offset));
      if (!closed) break;
    } else if (/[A-Za-z_$]/.test(char)) {
      offset++;
      while (offset < source.length && /[A-Za-z0-9_$]/.test(source[offset])) offset++;
      push('identifier', start, startLine, source.slice(start, offset));
    } else {
      NUMBER.lastIndex = offset;
      const match = NUMBER.exec(source);
      if (match) { offset = NUMBER.lastIndex; push('number', start, startLine, match[0]); }
      else { offset++; push('symbol', start, startLine, char); }
    }
  }
  return tokens;
}

function stringLiteral(raw) {
  let result = '';
  if (!raw.startsWith('"') || !raw.endsWith('"')) return null;
  for (let i = 1; i < raw.length - 1; i++) {
    let char = raw[i];
    if (char === '\\') {
      char = raw[++i];
      const escapes = { '\\': '\\', '"': '"', n: '\n', r: '\r', t: '\t' };
      if (Object.hasOwn(escapes, char)) result += escapes[char];
      else if (char === 'u' || char === 'U') {
        const length = char === 'u' ? 4 : 8;
        const hex = raw.slice(i + 1, i + 1 + length);
        if (hex.length !== length || !/^[0-9a-f]+$/i.test(hex)) return null;
        const code = Number.parseInt(hex, 16);
        if (code > 0x10ffff || code >= 0xd800 && code <= 0xdfff) return null;
        result += String.fromCodePoint(code);
        i += length;
      } else return null;
    } else {
      if (char === '"') return null;
      result += char;
    }
  }
  return validString(result) ? result : null;
}

function literal(tokens) {
  let cursor = 0;
  const readNumber = () => {
    let sign = 1;
    if (tokens[cursor]?.value === '+' || tokens[cursor]?.value === '-') sign = tokens[cursor++].value === '-' ? -1 : 1;
    if (tokens[cursor]?.type !== 'number') return undefined;
    const value = sign * Number(tokens[cursor++].value);
    return safeNumber(value) ? value : undefined;
  };
  let type, value;
  if (tokens[0]?.type === 'string' && tokens.length === 1) {
    value = stringLiteral(tokens[0].value);
    return value === null ? null : { type: 'string', value };
  }
  if (tokens[0]?.type === 'identifier' && ['true', 'false'].includes(tokens[0].value) && tokens.length === 1) return { type: 'boolean', value: tokens[0].value === 'true' };
  if (tokens[0]?.value === '[') {
    type = 'vector';
    value = [];
    cursor++;
    while (cursor < tokens.length && tokens[cursor].value !== ']') {
      const number = readNumber();
      if (number === undefined || value.length >= LIMITS.vector) return null;
      value.push(number);
      if (tokens[cursor]?.value === ']') break;
      if (tokens[cursor++]?.value !== ',' || tokens[cursor]?.value === ']') return null;
    }
    if (tokens[cursor++]?.value !== ']' || !value.length) return null;
  } else { type = 'number'; value = readNumber(); }
  return value === undefined || cursor !== tokens.length ? null : { type, value };
}

function splitOutside(text, separator) {
  const parts = [];
  let start = 0, depth = 0, quote = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) { if (char === '\\') i++; else if (char === '"') quote = false; }
    else if (char === '"') quote = true;
    else if (char === '[') depth++;
    else if (char === ']') { if (--depth < 0) return null; }
    else if (char === separator && depth === 0) { parts.push(text.slice(start, i).trim()); start = i + 1; }
  }
  if (quote || depth !== 0) return null;
  parts.push(text.slice(start).trim());
  return parts;
}

function annotationBody(comment) {
  const text = comment.trim();
  if (!text.startsWith('[')) return null;
  let depth = 0, quote = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) { if (char === '\\') i++; else if (char === '"') quote = false; }
    else if (char === '"') quote = true;
    else if (char === '[') depth++;
    else if (char === ']' && --depth === 0) return text.slice(1, i).trim();
  }
  return null;
}

function metadata(comment, type) {
  const body = annotationBody(comment);
  if (!body) return {};
  const items = splitOutside(body, ',');
  if (!items || items.length > LIMITS.options || items.some((item) => !item)) return {};
  if (items.length === 1 && (type === 'number' || type === 'vector')) {
    const fields = splitOutside(body, ':');
    const values = fields?.map((field) => literal(tokenize(field)));
    if (values?.every((item) => item?.type === 'number') && values.length <= 3) {
      const numbers = values.map((item) => item.value);
      if (numbers.length === 1 && numbers[0] >= 0) return { min: 0, max: numbers[0] };
      if (numbers.length >= 2) {
        const [min, middle, max] = numbers.length === 3 ? numbers : [numbers[0], undefined, numbers[1]];
        if (min <= max && (middle === undefined || middle > 0)) return { min, max, ...(middle === undefined ? {} : { step: middle }) };
        return {};
      }
    }
  }
  const options = [];
  for (const item of items) {
    const fields = splitOutside(item, ':');
    if (!fields || fields.length > 2 || !fields[0]) return {};
    const raw = fields[0];
    let parsed;
    if (type === 'string') {
      const value = raw.startsWith('"') ? stringLiteral(raw) : raw;
      if (value === null || !validString(value)) return {};
      parsed = { type, value };
    } else parsed = literal(tokenize(raw));
    if (!parsed || parsed.type !== type) return {};
    const rawLabel = fields[1] || (Array.isArray(parsed.value) ? `[${parsed.value.join(', ')}]` : String(parsed.value));
    const label = rawLabel.startsWith('"') ? stringLiteral(rawLabel) : rawLabel;
    if (label === null || !validString(label)) return {};
    if (!options.some((option) => sameValue(option.value, parsed.value))) options.push({ value: parsed.value, label });
  }
  return options.length ? { options } : {};
}

function parseScadParameters(source) {
  if (typeof source !== 'string') fail('SCADソースは文字列で指定してください');
  if (source.length > LIMITS.source) fail('SCADソースがパラメータ解析の文字数上限を超えています');
  const tokens = tokenize(source);
  const parameters = new Map();
  let group = 'parameters', description = [], lastDescriptionLine = -2;
  let statement = [], parentheses = 0, brackets = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === 'invalid') break;
    if (token.type.endsWith('comment')) {
      if (statement.length) continue;
      const tab = token.type === 'block-comment' && /^\s*\[([^\]\r\n]+)\]\s*$/.exec(token.value);
      if (tab) { group = tab[1].trim().slice(0, 256); description = []; lastDescriptionLine = -2; }
      else if (token.type === 'line-comment') {
        if (lastDescriptionLine + 1 < token.line) description = [];
        description.push(token.value.trim());
        lastDescriptionLine = token.endLine;
      } else { description = []; lastDescriptionLine = -2; }
      continue;
    }
    if (!statement.length && token.type === 'identifier') {
      // Conservative public-header boundary. We do not infer module arguments
      // or walk function/module bodies, including their inline forms.
      if (token.value === 'module' || token.value === 'function') break;
      if (token.value === 'include' || token.value === 'use') {
        while (i < tokens.length && tokens[i].value !== '>') i++;
        if (tokens[i + 1]?.value === ';') i++;
        if (tokens[i + 1]?.type === 'line-comment' && tokens[i + 1].line === tokens[i]?.endLine) i++;
        description = []; lastDescriptionLine = -2;
        continue;
      }
    }
    if (token.value === '{' || token.value === '}') break;
    if (token.value === ';' && parentheses === 0 && brackets === 0) {
      const [name, equals, ...valueTokens] = statement;
      let comment = '';
      if (tokens[i + 1]?.type === 'line-comment' && tokens[i + 1].line === token.line) comment = tokens[++i].value;
      if (name?.type === 'identifier' && equals?.value === '=') {
        parameters.delete(name.value);
        const parsed = literal(valueTokens);
        if (safeName(name.value) && parsed && group !== 'Hidden') {
          if (parameters.size >= LIMITS.parameters) fail('公開SCADパラメータが上限（256件）を超えています');
          parameters.set(name.value, {
            name: name.value, label: name.value.replace(/_+/g, ' ').trim() || name.value,
            description: lastDescriptionLine + 1 >= name.line ? description.join('\n').slice(0, LIMITS.string) : '',
            group, type: parsed.type, defaultValue: parsed.value, ...metadata(comment, parsed.type),
          });
        }
      }
      statement = []; description = []; lastDescriptionLine = -2;
      continue;
    }
    statement.push(token);
    if (token.value === '(') parentheses++;
    if (token.value === ')') parentheses--;
    if (token.value === '[') brackets++;
    if (token.value === ']') brackets--;
    if (parentheses < 0 || brackets < 0) break;
  }
  return [...parameters.values()];
}

function suggestPartSelector(parameters) {
  if (!Array.isArray(parameters)) return null;
  let best = null, bestScore = 0;
  for (const parameter of parameters) {
    if (!safeName(parameter?.name) || !Array.isArray(parameter.options) || parameter.options.length < 2) continue;
    const name = parameter.name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
    const words = name.split(/_+/);
    let score = ['part', 'piece', 'component'].includes(name) ? 100 : words.some((word) => ['part', 'piece', 'component'].includes(word)) ? 90 : 0;
    if (['selector', 'show', 'render', 'output'].includes(name)) score = Math.max(score, 80);
    else if (words.some((word) => ['selector', 'show', 'render', 'output'].includes(word))) score = Math.max(score, 65);
    if (score > bestScore) { best = parameter.name; bestScore = score; }
  }
  return best;
}

function overrideEntries(overrides) {
  if (!overrides || typeof overrides !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(overrides))) fail('SCADパラメータはオブジェクトで指定してください');
  const descriptors = Object.getOwnPropertyDescriptors(overrides);
  const names = Object.keys(descriptors);
  if (names.length > LIMITS.parameters || Object.getOwnPropertySymbols(overrides).length) fail('SCADパラメータの指定数が多すぎるか形式が不正です');
  return names.map((name) => {
    const descriptor = descriptors[name];
    if (!safeName(name) || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail('SCADパラメータ名または指定形式が不正です');
    return [name, descriptor.value];
  });
}

function supportedValue(value) {
  if (safeNumber(value) || typeof value === 'boolean' || validString(value)) return value;
  if (Array.isArray(value) && value.length > 0 && value.length <= LIMITS.vector) {
    const result = [];
    for (let i = 0; i < value.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !safeNumber(descriptor.value)) fail('SCADのベクトルには有限の数値だけを指定してください');
      result.push(descriptor.value);
    }
    return result;
  }
  fail('SCADパラメータの型・大きさ・文字列が不正です');
}

function validateScadOverrides(parameters, overrides) {
  if (!Array.isArray(parameters) || parameters.length > LIMITS.parameters) fail('SCADパラメータ定義が不正です');
  const schema = new Map(parameters.map((parameter) => [parameter.name, parameter]));
  const output = {};
  for (const [name, raw] of overrideEntries(overrides)) {
    const parameter = schema.get(name);
    if (!parameter || !safeName(parameter.name) || !TYPES.has(parameter.type)) fail(`公開されていないSCADパラメータです: ${name}`);
    const value = supportedValue(raw);
    const type = Array.isArray(value) ? 'vector' : typeof value;
    if (type !== parameter.type) fail(`SCADパラメータ「${name}」の型が一致しません`);
    if (type === 'vector' && value.length !== parameter.defaultValue.length) fail(`SCADパラメータ「${name}」のベクトル要素数が一致しません`);
    // The author's literal default remains valid even when slider annotations
    // do not align with it (the official examples include such defaults).
    if (!sameValue(value, parameter.defaultValue)) {
      if (parameter.options && !parameter.options.some((option) => sameValue(option.value, value))) fail(`SCADパラメータ「${name}」は定義済みの選択肢から選んでください`);
      const values = type === 'vector' ? value : type === 'number' ? [value] : [];
      for (const [index, number] of values.entries()) {
        if (type === 'vector' && number === parameter.defaultValue[index]) continue;
        if (parameter.min !== undefined && number < parameter.min || parameter.max !== undefined && number > parameter.max) fail(`SCADパラメータ「${name}」が指定範囲を超えています`);
        if (parameter.step !== undefined) {
          const ticks = (number - (parameter.min ?? 0)) / parameter.step;
          if (!Number.isFinite(ticks) || Math.abs(ticks - Math.round(ticks)) > 1e-7) fail(`SCADパラメータ「${name}」が指定刻みに一致しません`);
        }
      }
    }
    output[name] = value;
  }
  // Enforce the command-line budget before handing the result to the engine.
  scadDefineArgs(output);
  return output;
}

function scadString(value) {
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"';
}

function scadLiteral(value) {
  if (typeof value === 'string') return scadString(value);
  if (Array.isArray(value)) return '[' + value.map((number) => Object.is(number, -0) ? '0' : String(number)).join(',') + ']';
  return Object.is(value, -0) ? '0' : String(value);
}

function scadDefineArgs(overrides) {
  const args = [];
  let length = 0;
  for (const [name, raw] of overrideEntries(overrides).sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    const value = supportedValue(raw);
    const define = `${name}=${scadLiteral(value)}`;
    length += define.length + 4;
    if (length > LIMITS.defineChars) fail('SCADパラメータのコマンド長が上限を超えています');
    args.push('-D', define);
  }
  return args;
}

module.exports = { parseScadParameters, suggestPartSelector, validateScadOverrides, scadDefineArgs };
