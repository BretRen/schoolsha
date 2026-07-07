// ============================================================
// cards.ts — 卡牌定义与操作
// ============================================================

import type { Card, Suit, CardsConfig } from "./types.ts";
import cardsConfig from "./cards.json" with { type: "json" };

// 中文显示
export function cardLabel(c: Card): string {
  const suitMap: Record<Suit, string> = {
    spade: "♠", heart: "♥", club: "♣", diamond: "♦",
  };
  const numMap: Record<number, string> = {
    1: "A", 11: "J", 12: "Q", 13: "K",
  };
  const num = numMap[c.number] ?? String(c.number);
  return `${suitMap[c.suit]}${num} ${c.name}`;
}

let _idCounter = 0;
function nextId(): string {
  return `C${++_idCounter}`;
}

export function createDeck(): Card[] {
  _idCounter = 0;
  const config = cardsConfig as CardsConfig;
  const cards: Card[] = [];
  for (const spec of config.cards) {
    for (let i = 0; i < spec.count; i++) {
      cards.push({
        id: nextId(),
        name: spec.name,
        suit: spec.suit as Suit,
        number: spec.number,
      });
    }
  }
  return cards;
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
