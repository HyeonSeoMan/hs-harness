// 테스트 전용 가짜 claude / codex 실행 파일. 모델을 호출하지 않는다.
// 동작은 환경변수 FAKE_SCENARIO(JSON)로 정하고, FAKE_LOG가 있으면 호출 내용을 JSONL로 남긴다.
import { appendFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const sc = JSON.parse(process.env.FAKE_SCENARIO ?? '{}');
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const stdin = Buffer.concat(chunks).toString('utf8');

if (process.env.FAKE_LOG) {
  appendFileSync(
    process.env.FAKE_LOG,
    JSON.stringify({
      args,
      stdin,
      cwd: process.cwd(),
      hasAnthropicKey: 'ANTHROPIC_API_KEY' in process.env,
      hasOpenaiKey: 'OPENAI_API_KEY' in process.env,
    }) + '\n',
  );
}

if (args[0] === 'auth' && args[1] === 'status') {
  console.log(JSON.stringify({ loggedIn: sc.loggedIn ?? true, email: 'secret@example.com' }));
  process.exit(sc.loggedIn === false ? 1 : 0);
}
if (args[0] === 'login' && args[1] === 'status') {
  console.log(sc.loggedIn === false ? 'Not logged in' : 'Logged in using ChatGPT');
  process.exit(sc.loggedIn === false ? 1 : 0);
}

if (sc.hang) setInterval(() => {}, 1000); // 종료 신호를 받을 때까지 대기

if (args.includes('exec')) {
  // codex: 최종 답변은 -o 파일로, 이벤트는 stdout JSONL로
  if (sc.codexLastMessage !== undefined) writeFileSync(args[args.indexOf('-o') + 1], sc.codexLastMessage);
  for (const ev of sc.codexEvents ?? []) console.log(JSON.stringify(ev));
  if (!sc.hang) process.exit(sc.exit ?? 0);
} else if (!sc.hang) {
  // claude: --output-format json 의 단일 결과
  if (sc.claudeStdout !== undefined) process.stdout.write(sc.claudeStdout);
  process.exit(sc.exit ?? 0);
}
