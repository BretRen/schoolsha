// const.ts — 常量和工具函数

const HTTP_URL = `${location.protocol}//${location.host}`;
const WS_URL = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
const AUTH = { enabled: false, provider: "", clientId: "", token: null };
const esc = s => { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; };
const suitSym = s => ({ spade: "♠", heart: "♥", club: "♣", diamond: "♦" }[s] || "?");
const cn = c => c?.name || "?";
const hpStr = (hp, max) => { let s = ""; for (let i = 0; i < max; i++) s += i < hp ? "♥" : "♡"; return s; };
const isWeapon = n => WEAPON_NAMES.has(n);

// ====== 常量 ======
const CARD_DESC = {
  "作业": "对手需出【豁免】抵消，否则受 1 点伤害",
  "豁免": "响应【作业】或【点名批评】",
  "补给": "回复 1 点体力，或濒死时自救",
  "辩论": "双方轮流出【作业】，先不出者受 1 点伤害",
  "突击测验": "对手需出【作业】，否则受 1 点伤害",
  "点名批评": "对手需出【豁免】，否则受 1 点伤害",
  "告密": "盲选弃置对手一张手牌或装备",
  "小抄": "本回合下一张【作业】伤害 +1；或濒死时自救",
  "神偷": "盲选获取对手一张手牌或装备",
  "陷害": "随机弃置对手两张手牌或装备",
  "嫁祸": "对手需弃一张牌，否则受 1 点伤害",
  "午饭": "摸 2 张牌",
  "午饭留堂": "对手随机弃一张手牌或装备",
  "感冒": "造成 1 点伤害",
  "免罚券": "抵消一张锦囊牌（辩论/突击测验/最终测试/嫁祸）",
  "最终测试": "全体各抽 2 张牌",
  "钢笔": "武器：攻击未闪避时伤害 +1",
  "圆规": "武器：【作业】无视出牌次数限制",
  "尺子": "武器：对手出【豁免】后，可再出一张【作业】",
  "橡皮": "武器：【作业】被豁免后仍造成 1 点伤害",
  "校服": "防具：黑色【作业】无效",
  "黑名单": "防具：【作业】无效；受到【陷害】【点名批评】伤害+1",
  "涂改液": "防具：被【作业】时翻牌判定，翻出红色则自动闪避",
};
const SKILL_DESC = {
  class_president: "出牌阶段弃一张手牌，令对手也弃一张手牌。每回合限一次。",
  athletic: "锁定技。手牌上限+1。",
  tutoring: "锁定技。摸牌阶段多摸一张牌。",
};
const WEAPON_NAMES = new Set(["钢笔", "圆规", "尺子", "橡皮"]);
const DEFENSIVE_ONLY = ["豁免", "免罚券"];
const RESP_CARDS = { dodge: ["豁免"], near_death: ["补给", "小抄"], duel: ["作业"], barbarian: ["作业"], volley: ["豁免"], borrow_knife: null };
const RESP_NAMES = {
  dodge: "对手对你使用了【作业】，请出【豁免】",
  near_death: "你处于濒死状态，请出【补给】或【小抄】自救",
  duel: "对手发起【辩论】，请出【作业】",
  barbarian: "【突击测验】！请出【作业】",
  volley: "【点名批评】！请出【豁免】",
  borrow_knife: "【嫁祸】！请弃一张牌",
  steal: p => p.stealAction === "discard" ? "【告密】！选择对手一张牌弃掉（10秒）" : "【神偷】！选择对手一张牌获取（10秒）",
  skill_discard: "请弃一张手牌以发动技能",
  opponent_discard: "对手技能生效！请选择要弃的牌",
  judge_armor: "是否发动【涂改液】翻牌判定？（8秒）",
  pick_discard: "【陷害】从对手牌中选择 2 张弃置（15秒）",
};
const RESP_NAMES_OPP = {
  dodge: "等待对手出【豁免】响应你的【作业】",
  near_death: "对手濒死，等待使用【补给】",
  duel: "等待对手出【作业】响应【辩论】",
  barbarian: "等待对手出【作业】响应【突击测验】",
  volley: "等待对手出【豁免】响应【点名批评】",
  borrow_knife: "等待对手弃牌响应【嫁祸】",
  steal: "对手正在盲选你的牌...",
  skill_discard: "对手正在弃牌发动技能...",
  opponent_discard: "等待对手弃牌响应你的技能...",
  judge_armor: "等待对手决定是否发动【涂改液】...",
  pick_discard: "正在选择要弃置的牌...",
};
const PN = { judge: "判定", draw: "摸牌", play: "出牌", discard: "弃牌", end: "结束" };

function getCardDesc(c) { return CARD_DESC[c.name] || `${c.name}（${suitSym(c.suit)}${c.number}）`; }
function getSkillDesc(s) { return SKILL_DESC[s.id] || s.name; }
