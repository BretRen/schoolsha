// ============================================================
// cards.ts — 卡牌定义（标准 54 张）
// ============================================================

import type { Card, CardName, Suit } from "./types.ts";

// 中文显示
export function cardLabel(c: Card): string {
  const suitMap: Record<Suit, string> = {
    spade: "♠",
    heart: "♥",
    club: "♣",
    diamond: "♦",
  };
  const numMap: Record<number, string> = {
    1: "A",
    11: "J",
    12: "Q",
    13: "K",
  };
  const num = numMap[c.number] ?? String(c.number);
  return `${suitMap[c.suit]}${num} ${c.name}`;
}

// 标准 54 张牌（三国杀经典配比）
const CARD_SPECS: Array<[CardName, Suit, number]> = [
  // 杀 × 30
  ...Array(7).fill(["杀", "spade", 7] as const), // ♠7 × 7
  ...Array(3).fill(["杀", "spade", 8] as const), // ♠8 × 3
  ...Array(3).fill(["杀", "spade", 9] as const), // ♠9 × 3
  ...Array(2).fill(["杀", "spade", 10] as const), // ♠10 × 2
  ...Array(4).fill(["杀", "club", 2] as const), // ♣2 × 4
  ...Array(3).fill(["杀", "club", 3] as const), // ♣3 × 3
  ...Array(3).fill(["杀", "club", 4] as const), // ♣4 × 3
  ...Array(2).fill(["杀", "heart", 10] as const), // ♥10 × 2
  ...Array(2).fill(["杀", "diamond", 10] as const), // ♦10 × 2
  ...Array(1).fill(["杀", "diamond", 9] as const), // ♦9 × 1

  // 闪 × 14
  ...Array(3).fill(["闪", "diamond", 2] as const),
  ...Array(3).fill(["闪", "diamond", 3] as const),
  ...Array(2).fill(["闪", "diamond", 4] as const),
  ...Array(2).fill(["闪", "diamond", 5] as const),
  ...Array(2).fill(["闪", "diamond", 6] as const),
  ...Array(2).fill(["闪", "diamond", 7] as const),

  // 桃 × 10
  ...Array(3).fill(["桃", "heart", 2] as const),
  ...Array(2).fill(["桃", "heart", 3] as const),
  ...Array(2).fill(["桃", "heart", 4] as const),
  ...Array(2).fill(["桃", "heart", 5] as const),
  ...Array(1).fill(["桃", "heart", 6] as const),

  // 决斗 × 3
  ...Array(1).fill(["决斗", "spade", 1] as const),
  ...Array(1).fill(["决斗", "club", 1] as const),
  ...Array(1).fill(["决斗", "diamond", 1] as const),
];

let _idCounter = 0;
function nextId(): string {
  return `C${++_idCounter}`;
}

export function createDeck(): Card[] {
  _idCounter = 0;
  return CARD_SPECS.map(([name, suit, number]) => ({
    id: nextId(),
    name: name as CardName,
    suit: suit as Suit,
    number,
  }));
}

export function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function drawCards(deck: Card[], discard: Card[], count: number): {
  drawn: Card[];
  deck: Card[];
  discard: Card[];
} {
  const drawn: Card[] = [];
  for (let i = 0; i < count; i++) {
    if (deck.length === 0) {
      // 重洗弃牌堆
      if (discard.length === 0) break;
      deck.push(...shuffle([...discard]));
      discard.length = 0;
    }
    const card = deck.pop()!;
    drawn.push(card);
  }
  return { drawn, deck, discard };
}

export function removeCard(hand: Card[], cardId: string): Card | null {
  const idx = hand.findIndex((c) => c.id === cardId);
  if (idx === -1) return null;
  return hand.splice(idx, 1)[0];
}

export function hasCard(hand: Card[], cardId: string): boolean {
  return hand.some((c) => c.id === cardId);
}
