// ============================================================
// test_integration.ts — 全流程集成测试
// ============================================================

const URL = "http://localhost:8099";

// ---------- 工具 ----------

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}${detail ? " — " + detail : ""}`); }
}

// 消息队列模式的 recv — 避免 Deno WebSocket 消息丢失
class WsClient {
  ws: WebSocket;
// deno-lint-ignore no-explicit-any
  private queue: any[] = [];
  // deno-lint-ignore no-explicit-any
  private waiters: ((m: any) => void)[] = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (this.waiters.length) this.waiters.shift()!(m);
      else this.queue.push(m);
    };
    this.ws.onerror = () => {
      if (this.waiters.length) this.waiters.shift()!({ type: "error", message: "ws error" });
    };
  }

  // deno-lint-ignore no-explicit-any
  recv(timeout = 5000): Promise<any> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout")), timeout);
      if (this.queue.length) {
        clearTimeout(t);
        resolve(this.queue.shift());
      } else {
        this.waiters.push((m) => { clearTimeout(t); resolve(m); });
      }
    });
  }

  // deno-lint-ignore no-explicit-any
  send(msg: any) { this.ws.send(JSON.stringify(msg)); }
  close() { this.ws.close(); }
}

// ---------- HTTP 测试 ----------

async function testHTTP(): Promise<string> {
  console.log("\n📋 HTTP 端点");

  const infoResp = await fetch(`${URL}/info`);
  ok("/info 200", infoResp.status === 200);
  const infoJson = await infoResp.json();
  ok("version", typeof infoJson.version === "string");
  ok("rooms", typeof infoJson.rooms === "number");

  const roomResp = await fetch(`${URL}/room/create`);
  ok("/room/create 200", roomResp.status === 200);
  const room = await roomResp.json();
  ok("code 6位", room.code?.length === 6);
  ok("wsUrl", room.wsUrl?.includes("ws"));
  ok("inviteUrl", room.inviteUrl?.includes("/invite/"));
  ok("deepLink", room.deepLink?.startsWith("pdnode://"));

  const inviteResp = await fetch(`${URL}/invite/${room.code}`);
  ok("/invite HTML", inviteResp.status === 200);
  ok("HTML 含房间码", (await inviteResp.text()).includes(room.code));

  const lbResp = await fetch(`${URL}/leaderboard`);
  ok("/leaderboard 200", lbResp.status === 200);
  const lb = await lbResp.json();
  ok("top10 数组", Array.isArray(lb.top10));

  const webResp = await fetch(`${URL}/`);
  ok("/ HTML", webResp.status === 200 && (await webResp.text()).includes("学校杀"));

  ok("/web/style.css", (await fetch(`${URL}/web/style.css`)).status === 200);
  ok("/web/app.js", (await fetch(`${URL}/web/app.js`)).status === 200);

  return room.code;
}

// ---------- WS 游戏流程测试 ----------

async function testRoomGame(code: string) {
  console.log("\n📋 房间游戏");

  // P1 连接
  const ws1 = new WsClient(`ws://localhost:8099/ws?room=${code}`);
  const m1 = await ws1.recv();
  ok("P1 waiting", m1.type === "waiting", `got ${m1.type}`);

  // P2 连接（在 P1 进入 waiting 后）
  const ws2 = new WsClient(`ws://localhost:8099/ws?room=${code}`);

  // 双方收到选角
  const cs1 = await ws1.recv();
  const cs2 = await ws2.recv();
  ok("P1 选角", cs1.type === "character_select");
  ok("P2 选角", cs2.type === "character_select");
  const chars = cs1.characters;
  ok("角色 > 0", chars.length > 0);

  // 选角
  ws1.send({ action: "pick_character", id: chars[0].id });
  ws2.send({ action: "pick_character", id: chars[1]?.id || chars[0].id });

  // 游戏开始
  const gs1 = await ws1.recv();
  ok("game_state", gs1.type === "game_state");
  ok("phase", typeof gs1.state.phase === "string");
  ok("hand 存在", Array.isArray(gs1.state.you.hand));
  ok("hand > 0", gs1.state.you.hand.length > 0);
  ok("playerName", typeof gs1.state.playerName === "string");
  ok("opponentName", typeof gs1.state.opponentName === "string");

  ws1.close();
  ws2.close();
}

// ---------- 匹配测试 ----------

async function testMatchmaking() {
  console.log("\n📋 匹配系统");

  const ws1 = new WsClient("ws://localhost:8099/ws?mode=matching");
  const q1 = await ws1.recv();
  ok("P1 入队", q1.type === "queue_status");

  // P2 在 P1 完全入队后再连接（避免 Deno WS 竞态）
  await new Promise(r => setTimeout(r, 200));
  const ws2 = new WsClient("ws://localhost:8099/ws?mode=matching");

  // P2 会先收到 queue_status，再收到 match_found
  const q2 = await ws2.recv();
  ok("P2 入队", q2.type === "queue_status");

  const m1 = await ws1.recv();
  ok("P1 匹配", m1.type === "match_found");
  ok("房间码", m1.room?.length === 6);
  ok("对手 ELO", typeof m1.opponent?.elo === "number");

  const m2 = await ws2.recv();
  ok("P2 匹配", m2.type === "match_found");
  ok("房间码一致", m2.room === m1.room);

  // 用匹配到的房间再玩一局
  await testRoomGame(m1.room);
}

// ---------- 主入口 ----------

async function main() {
  console.log("🔪 学校杀 集成测试\n");

  try {
    const code = await testHTTP();
    await testRoomGame(code);
    await testMatchmaking();
  } finally {
    try { Deno.removeSync("./elo.json"); } catch { /* ok */ }
  }

  console.log(`\n${"=".repeat(40)}`);
  console.log(`  通过: ${passed}  失败: ${failed}  总计: ${passed + failed}`);
  console.log(`${"=".repeat(40)}`);
  if (failed > 0) Deno.exit(1);
}

main();
