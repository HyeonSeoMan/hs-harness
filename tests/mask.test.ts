import { describe, expect, it } from 'vitest';
import { maskSecrets, parseSingleJsonObject, redact } from '../src/cli/common.ts';

describe('maskSecrets (합성 값만 사용)', () => {
  it.each([
    ['token = syntheticToken123456', 'syntheticToken123456'],
    ['token=syntheticToken123456', 'syntheticToken123456'],
    ['token   :   syntheticToken123456', 'syntheticToken123456'],
    ['password: hunter2', 'hunter2'],
    ['PASSWORD = hunter2', 'hunter2'],
    ['"api_key": "synthvalue123"', 'synthvalue123'],
    ["'api_key' : 'synthvalue123'", 'synthvalue123'],
    ['{"access_token":"synthvalue123","x":1}', 'synthvalue123'],
    ['client_secret = "plainsecretvalue"', 'plainsecretvalue'], // 따옴표 값은 숫자가 없어도 가린다
    ['password: "changeme"', 'changeme'],
    ['export OPENAI_API_KEY=abc123def456', 'abc123def456'],
  ])('%s', (input, secret) => {
    const out = maskSecrets(input);
    expect(out).not.toContain(secret);
    expect(out).toContain('***');
  });

  it('키 이름은 남기고 값만 가린다', () => {
    expect(maskSecrets('password: hunter2')).toMatch(/^password\s*:\s*\*\*\*$/);
    expect(maskSecrets('"api_key": "synthvalue123"')).toBe('"api_key": "***"');
  });

  it.each([
    ['sk-synthetic-0123456789abcdef', 'sk-synthetic'],
    ['ghp_syntheticSYNTHETICsynthetic0123', 'ghp_synthetic'],
    ['AKIAIOSFODNN7SYNTH12', 'AKIAIOSFODNN7SYNTH12'],
    ['Authorization: Bearer synthetictoken0123456789', 'synthetictoken0123456789'],
  ])('기존 형태 유지: %s', (input, secret) => {
    expect(maskSecrets(input)).not.toContain(secret);
  });

  it('여러 줄의 비밀값을 모두 가리되 줄바꿈과 나머지 내용은 보존한다', () => {
    const out = maskSecrets('line1\ntoken = syntheticToken123456\npassword: hunter2\nline4 ends');
    expect(out.split('\n')).toHaveLength(4);
    expect(out).toContain('line1');
    expect(out).toContain('line4 ends');
    expect(out).not.toMatch(/syntheticToken123456|hunter2/);
  });

  it.each([
    'The token is invalid or expired.',
    'token: handling is missing in the retry path',
    'password: required field',
    'const token = getToken();',
    'const apiKey = process.env.API_KEY;',
    "api_key = os.environ['API_KEY']",
    'secret: string;',
    'max_tokens = 4096',
    'tokens: 1000 per minute',
    'password = x',
    'Use a stronger password = longer passphrase',
    'token = "${TOKEN}"',
    'the secret to good code review is reading the diff',
    'function validatePassword(password) { return password.length > 8 }',
    'Authorization header is missing',
  ])('일반 코드·설명은 그대로 둔다: %s', (text) => {
    expect(maskSecrets(text)).toBe(text);
  });

  it('redact는 마스킹 후 한 줄로 정리하고 길이를 제한한다', () => {
    expect(redact('a\n  token = syntheticToken123456\n b')).toBe('a token = *** b');
    expect(redact('x'.repeat(1000)).length).toBeLessThan(450);
  });
});

describe('parseSingleJsonObject: 키 중복(디코딩 후 기준)', () => {
  const ok = (t: string) => expect(parseSingleJsonObject(t)).not.toBeNull();
  const bad = (t: string) => expect(parseSingleJsonObject(t)).toBeNull();

  it('디코딩 후 같은 키는 거부한다', () => {
    bad(String.raw`{"verdict":"a","verdict":"b"}`);
    bad(String.raw`{"verdict":"a","verdict":"b"}`);
    bad(String.raw`{"a":1,"a":2}`);
    bad(String.raw`{"a\/b":1,"a/b":2}`); // \/ 도 같은 문자
    bad('{"a":1,"a":2}');
  });

  it('중첩 객체와 배열 속 객체도 객체별로 검사한다', () => {
    bad('{"o":{"k":1,"k":2}}');
    bad(String.raw`{"o":[{"k":1},{"x":1,"x":2}]}`);
    bad('{"a":{"b":{"c":[{"d":1,"d":2}]}}}');
  });

  it('형제 객체의 같은 키, 문자열 값 속 키 모양 텍스트, 이스케이프된 따옴표는 중복이 아니다', () => {
    ok('{"a":{"k":1},"b":{"k":2},"c":[{"k":1},{"k":2}]}');
    ok(String.raw`{"a":"{\"k\":1,\"k\":2}","b":"}{","c":"\\"}`);
    ok('{"a":1,"A":2}'); // 대소문자는 다른 키
    ok('{}');
    ok('{"a":[],"b":{}}');
  });

  it('유니코드 키와 서로게이트 쌍도 올바르게 비교한다', () => {
    ok(String.raw`{"한글":1,"한":2}`);
    bad(String.raw`{"한":1,"한":2}`);
    ok(String.raw`{"😀":1,"\ud83d":2}`); // 홀로 선 서로게이트는 다른 문자열
    bad(String.raw`{"😀":1,"😀":2}`);
  });
});

describe('maskSecrets: 따옴표로 감싼 값 전체를 파싱해 가린다 (내부 공백·반대 따옴표·이스케이프)', () => {
  it.each([
    ['Codex 재현 1: 내부 공백', 'password: "synthetic phrase 123456"', ['synthetic', 'phrase', '123456']],
    ['Codex 재현 2: 반대쪽 따옴표 포함', `client_secret = "synthetic'Quoted123"`, ['synthetic', 'Quoted123']],
    ['작은따옴표 값 안의 큰따옴표', `token: 'synth"quoted 987654'`, ['synth', 'quoted', '987654']],
    ['이스케이프된 큰따옴표', String.raw`api_key = "abc\"def123456 tail"`, ['def123456', 'tail']],
    ['이스케이프된 작은따옴표', String.raw`secret: 'it\'s a secret 1234'`, ['secret 1234', "it\\'s"]],
    ['숫자 없는 암구호', 'password = "correct horse battery staple"', ['correct', 'horse', 'battery', 'staple']],
    ['JSON 문자열 안에 이스케이프된 형태', String.raw`{\"api_key\": \"synth value 12345\"}`, ['synth value', '12345']],
    ['키 이름에 따옴표', `{"client_secret": "a b c 123456"}`, ['a b c', '123456']],
  ])('%s', (_name, input, leaked) => {
    const out = maskSecrets(input);
    for (const piece of leaked) expect(out, `leaked "${piece}" in: ${out}`).not.toContain(piece);
    expect(out).toContain('***');
  });

  it('같은 줄의 여러 값과 앞뒤 문맥은 보존하고, 닫히지 않은 따옴표는 그 줄 끝까지만 가린다', () => {
    const two = maskSecrets(`password: "a b 1234", token: 'c d 5678' ok`);
    expect(two).not.toMatch(/a b 1234|c d 5678/);
    expect(two).toContain(', ');
    expect(two.endsWith(' ok')).toBe(true);

    const open = maskSecrets('password: "never closed 123456\nnext line stays: fine');
    expect(open).not.toContain('123456');
    expect(open).toContain('next line stays: fine');
  });

  it('따옴표와 값의 구조(키 이름·따옴표·구분자)는 유지한다', () => {
    expect(maskSecrets('password: "synthetic phrase 123456"')).toBe('password: "***"');
    expect(maskSecrets(`client_secret = 'x y z 1234'`)).toBe(`client_secret = '***'`);
  });

  it.each([
    'password: "${PASSWORD}"',
    'password: "$PASSWORD"',
    'token = "<your token here>"',
    'secret: "{{ vault.secret }}"',
    'api_key = "{API_KEY}"',
    "password: '%(password)s'",
    'token = "%TOKEN%"',
    'password = ""',
    'token = "x"',
    'He said "hello world 123456" to me',
    'the label "password" is shown above the field',
    'if (password == "") return false;',
    'Enter your password: ',
  ])('자리표시자·빈 값·일반 문장은 가리지 않는다: %s', (text) => {
    expect(maskSecrets(text)).toBe(text);
  });
});

describe('maskSecrets: 외부 입력(최대 수 MB)에 대해 선형에 가깝게 동작한다', () => {
  it.each([
    ['키워드 반복', 'token'.repeat(1_000_000)],
    ['접두 문자 반복', ('api_key' + '_'.repeat(50)).repeat(80_000)],
    ['닫히지 않은 따옴표', `password: "${'x'.repeat(5_000_000)}`],
    ['백슬래시 반복', `password: "${'\\'.repeat(5_000_000)}`],
    ['짧은 쌍 반복', 'password: "ab cd 12", '.repeat(150_000)],
  ])('%s', (_name, text) => {
    const started = Date.now();
    maskSecrets(text);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('maskSecrets: 표현 계층(일반 텍스트 / JSON 인코딩 / 중첩 인코딩)', () => {
  const TAIL = 'SYNTHETIC_TAIL_123456';
  const plain = String.raw`api_key = "prefix\"${TAIL}"`; // 값 안에 이스케이프된 따옴표가 있는 일반 텍스트
  const once = JSON.stringify(plain); // Codex 재현: JSON.stringify 한 번
  const twice = JSON.stringify(once);
  const thrice = JSON.stringify(twice);
  const gone = (out: string) => {
    expect(out).not.toContain(TAIL);
    expect(out).not.toContain('prefix');
  };

  it('Codex 재현 그대로: JSON.stringify(일반 텍스트) 를 마스킹해도 접미부가 남지 않는다', () => {
    expect(maskSecrets(JSON.stringify(String.raw`api_key = "prefix\"SYNTHETIC_TAIL_123456"`)).includes('SYNTHETIC_TAIL_123456')).toBe(false);
  });

  it.each([
    ['일반 텍스트', plain],
    ['JSON.stringify 1회', once],
    ['JSON.stringify 2회', twice],
    ['JSON.stringify 3회', thrice],
  ])('%s: 값 전체(접미부 포함)를 가린다', (_name, input) => {
    gone(maskSecrets(input));
  });

  it('JSON 인코딩된 입력은 표현을 유지한다: 결과도 같은 층수의 유효한 JSON이고 풀면 일반 텍스트 마스킹 결과와 같다', () => {
    const expected = maskSecrets(plain); // api_key = "***"
    expect(expected).toBe('api_key = "***"');
    expect(JSON.parse(maskSecrets(once))).toBe(expected);
    expect(JSON.parse(JSON.parse(maskSecrets(twice)))).toBe(expected);
    expect(JSON.parse(JSON.parse(JSON.parse(maskSecrets(thrice))))).toBe(expected);
  });

  it('깊이 제한을 넘는 중첩 인코딩은 풀지 못하므로 통째로 가린다(fail-closed)', () => {
    let deep = plain;
    for (let i = 0; i < 20; i++) deep = JSON.stringify(deep);
    const out = maskSecrets(deep);
    gone(out);
    // 가린 자리 표시는 바깥 층에서 다시 인코딩되므로 따옴표 이스케이프만큼 늘어나지만 입력(20겹, 수 MB)과 무관하게 작다.
    expect(out.length).toBeLessThan(2000);
  });

  describe('일반 텍스트의 따옴표·연속 백슬래시', () => {
    it.each([
      ['이스케이프된 백슬래시 뒤의 닫는 따옴표', String.raw`password = "secret12\\" trailing words`, 'password = "***" trailing words'],
      ['이스케이프된 백슬래시 + 이스케이프된 따옴표', String.raw`password = "abc\\\"def123456" end`, 'password = "***" end'],
      ['백슬래시 4개 뒤의 닫는 따옴표', String.raw`token: "ab12cd\\\\" after`, 'token: "***" after'],
      ['이스케이프된 따옴표 연속', String.raw`secret = "a\"b\"c\"d123456" ok`, 'secret = "***" ok'],
    ])('%s', (_name, input, expected) => {
      expect(maskSecrets(input)).toBe(expected);
    });
  });

  describe('문장 속에 끼어 있는 JSON 인코딩 조각(전체가 JSON은 아님)', () => {
    it('한 겹 인코딩된 조각: 이스케이프된 따옴표를 가진 값도 끝까지 가리고 앞뒤 문맥은 보존한다', () => {
      const text = String.raw`Log: {\"api_key\": \"prefix\\\"${TAIL}\"} end`;
      const out = maskSecrets(text);
      gone(out);
      expect(out.startsWith('Log: {')).toBe(true);
      expect(out.endsWith('} end')).toBe(true);
    });

    it('한 겹 인코딩 조각의 일반 값(내부 공백 포함)도 가린다 (기존 동작 유지)', () => {
      const out = maskSecrets(String.raw`{\"api_key\": \"synth value 12345\"} tail`);
      expect(out).not.toContain('synth value');
      expect(out.endsWith('} tail')).toBe(true);
    });

    it('두 겹 이상으로 보이는 조각은 층수를 알 수 없으므로 그 줄 끝까지 가린다(fail-closed)', () => {
      const out = maskSecrets(String.raw`before {\\\"password\\\": \\\"hunter two 123456\\\"} after` + '\nnext line stays');
      expect(out).not.toContain('hunter two');
      expect(out.startsWith('before {')).toBe(true);
      expect(out.endsWith('next line stays')).toBe(true);
    });
  });

  describe('구조화된 JSON: 파싱한 실제 문자열 값에 적용한다', () => {
    it('비밀 키의 문자열 값과 값 안의 비밀 패턴을 가리고, 나머지 값은 그대로 둔다', () => {
      const input = JSON.stringify({
        password: 'my secret phrase here',
        note: 'see api_key = "x y 123456" in config',
        ok: 'fine text',
        nested: { token: 'abcdef1234567', list: [{ client_secret: 'a b c d' }], keep: 'const token = getToken();' },
      });
      const out = JSON.parse(maskSecrets(input));
      expect(out.password).toBe('***');
      expect(out.note).not.toMatch(/x y|123456/);
      expect(out.note).toContain('in config');
      expect(out.ok).toBe('fine text');
      expect(out.nested.token).toBe('***');
      expect(out.nested.list[0].client_secret).toBe('***');
      expect(out.nested.keep).toBe('const token = getToken();');
    });

    it('비밀 키 아래의 배열 원소와 긴 숫자도 가린다', () => {
      const out = JSON.parse(maskSecrets(JSON.stringify({ api_keys: ['first value', 'second value'], secret: 1234567890, max_tokens: 4096 })));
      expect(out.api_keys).toEqual(['***', '***']);
      expect(out.secret).toBe('***');
      expect(out.max_tokens).toBe(4096);
    });

    it('이중 인코딩된 객체(문자열 안의 JSON)도 안쪽 값까지 가린다', () => {
      const inner = JSON.stringify({ password: 'inner secret phrase', msg: 'plain' });
      const out = JSON.parse(maskSecrets(JSON.stringify({ feedback: inner })));
      expect(JSON.parse(out.feedback)).toEqual({ password: '***', msg: 'plain' });
    });

    it('가릴 것이 없는 JSON은 공백·들여쓰기까지 글자 그대로 돌려준다', () => {
      const pretty = JSON.stringify({ a: 1, b: ['x', 'y'], c: 'const token = getToken();', d: 'password: required' }, null, 2);
      expect(maskSecrets(pretty)).toBe(pretty);
      expect(maskSecrets('"just a quoted sentence"')).toBe('"just a quoted sentence"');
    });
  });

  describe('일반 텍스트의 의미를 바꾸지 않는다 (무조건 디코딩 금지)', () => {
    it.each([
      String.raw`see C:\new\table and "quoted" text`,
      String.raw`a literal backslash-n \n stays as two characters`,
      String.raw`Result: {"a":"b\nc"} done`,
      'He said "hello" and left',
      '[not json at all',
      '{"unterminated": "x"',
    ])('그대로 보존: %s', (text) => {
      expect(maskSecrets(text)).toBe(text);
    });

    it('JSON처럼 보이지만 전체가 JSON이 아닌 텍스트 속의 비밀은 일반 규칙으로 가리되 나머지는 그대로다', () => {
      const out = maskSecrets(String.raw`prefix {"password": "my phrase 123456", "n": "a\nb"} suffix`);
      expect(out).not.toContain('my phrase');
      expect(out).toContain(String.raw`"n": "a\nb"`); // \n 이 개행으로 바뀌지 않는다
      expect(out.startsWith('prefix {')).toBe(true);
    });
  });
});

describe('maskSecrets: 표현 계층 처리의 성능', () => {
  it.each([
    ['5MB 문자열을 한 번 인코딩', () => JSON.stringify(`password: "${'ab\\"cd '.repeat(800_000)}"`)],
    ['4겹 인코딩된 큰 문자열', () => [1, 2, 3, 4].reduce((acc) => JSON.stringify(acc), `token = "${'x'.repeat(1_000_000)} 123456"`)],
    ['큰 JSON 객체(원소 20만 개)', () => JSON.stringify({ items: Array.from({ length: 200_000 }, (_, i) => ({ k: `value ${i}`, password: 'p q r s' })) })],
    ['한 겹 조각 안의 백슬래시 500만 개', () => String.raw`{\"token\": \"` + '\\\\'.repeat(2_500_000)],
    ['중첩 대괄호 10만 겹', () => '['.repeat(100_000) + ']'.repeat(100_000)],
    ['큰따옴표 없는 긴 텍스트', () => 'plain words 123 '.repeat(500_000)],
  ])('%s', (_name, make) => {
    const text = make();
    const started = Date.now();
    maskSecrets(text);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe('maskSecrets: 표현 계층 × 따옴표·백슬래시 조합 (시드 고정 속성 테스트)', () => {
  /** 결정적 난수 (mulberry32) — 실패 시 같은 입력이 재현된다. */
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const KEYS = ['api_key', 'password', 'client_secret', 'access_token', 'TOKEN', 'Secret'] as const;
  const SEPS = ['=', ' = ', ': ', ' : ', ':'] as const;

  /** 일반 텍스트 문법으로 유효한 따옴표 값 본문(이스케이프된 따옴표·백슬래시·반대쪽 따옴표·공백·숫자)과 마지막의 고유 꼬리 */
  const valueBody = (r: () => number, q: string, tail: string) => {
    const other = q === '"' ? "'" : '"';
    const tokens = ['ab', ' ', '12', `\\${q}`, '\\\\', other, 'x_y', '{', '}', '한글'];
    let v = '';
    for (let i = 0, n = 2 + Math.floor(r() * 8); i < n; i++) v += pick(r, tokens);
    return v + tail;
  };
  const decodeLayers = (s: string, n: number) => {
    for (let i = 0; i < n; i++) s = JSON.parse(s) as string;
    return s;
  };

  it('전체가 0~4겹 JSON 으로 인코딩된 피드백에서 꼬리까지 가리고, 풀면 뒤 문맥이 보존된다 (400가지 조합)', () => {
    const r = rng(20260706);
    for (let n = 0; n < 400; n++) {
      const q = pick(r, ['"', "'"] as const);
      const tail = `ZQXTAIL${n}${'7'.repeat(3)}`;
      const plain = `Fix this: ${pick(r, KEYS)}${pick(r, SEPS)}${q}${valueBody(r, q, tail)}${q} trailing words here`;
      const layers = Math.floor(r() * 5);
      let input = plain;
      for (let i = 0; i < layers; i++) input = JSON.stringify(input);

      const out = maskSecrets(input);
      const label = `layers=${layers} plain=${plain}`;
      expect(out, label).not.toContain(tail);
      const decoded = decodeLayers(out, layers); // 같은 층수의 JSON 으로 유지된다
      expect(decoded, label).toContain('trailing words here');
      expect(decoded.startsWith('Fix this: '), label).toBe(true);
    }
  });

  it('문장 속에 한 겹 인코딩된 JSON 조각이 섞여 있어도 꼬리까지 가리고 앞뒤 문맥을 보존한다 (300가지 조합)', () => {
    const r = rng(77);
    for (let n = 0; n < 300; n++) {
      const tail = `ZQXTAIL${n}${'9'.repeat(3)}`;
      // 값(일반 텍스트 문법)을 JSON 문자열 내용으로 한 번 인코딩한다: \ → \\, " → \"
      const value = valueBody(r, '"', tail);
      const encoded = JSON.stringify(value).slice(1, -1);
      const key = pick(r, KEYS);
      const input = `before {\\"${key}\\": \\"${encoded}\\"} after words`;

      const out = maskSecrets(input);
      const label = `value=${value}`;
      expect(out, label).not.toContain(tail);
      expect(out.startsWith('before {'), label).toBe(true);
      expect(out.endsWith('} after words'), label).toBe(true);
    }
  });
});

describe('maskSecrets: 자리표시자는 값 전체가 자리표시자일 때만 예외다', () => {
  it.each([
    ['password: "${HOME}realsecret123"', 'realsecret123'],
    ["token = '<your>abc123def456'", 'abc123def456'],
    ['api_key = "{12ZQXtail999"', 'ZQXtail999'],
    ['secret: "%TOKEN%suffix7890"', 'suffix7890'],
    ['password: "{{ vault }}plus tail 12"', 'plus tail'],
  ])('%s', (input, secret) => {
    expect(maskSecrets(input)).not.toContain(secret);
  });
});
