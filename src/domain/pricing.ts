/**
 * Dynamic pricing (section 11). HARD RULE: returned price is never below `floor`
 * (= all costs + minimum required profit/margin, from calculateProfit().minAllowedPrice).
 * Anti price-war: small steps, cool-down, never chase a competitor below our floor.
 */
export interface PriceInput {
  currentPrice: number;
  floor: number;
  ceiling: number;
  lowestCompetitor?: number | null;
  buyBoxPrice?: number | null;
  hoursSinceLastChange: number;
  maxChangePct: number;
  cooldownHours: number;
  undercutSek: number;
}

export interface PriceDecision { newPrice: number; changed: boolean; reason: string; competitorBelowFloor: boolean }

export function decidePrice(i: PriceInput): PriceDecision {
  const floor = Math.ceil(i.floor);
  const ceiling = Math.max(floor, Math.floor(i.ceiling));
  const ref = i.buyBoxPrice ?? i.lowestCompetitor ?? null;
  const competitorBelowFloor = ref != null && ref - i.undercutSek < floor;

  // 1) Cost/floor protection overrides cool-down and step limits.
  if (i.currentPrice < floor) {
    return { newPrice: floor, changed: true, reason: `raised to floor ${floor} (costs increased)`, competitorBelowFloor };
  }
  if (i.hoursSinceLastChange < i.cooldownHours) {
    return { newPrice: i.currentPrice, changed: false, reason: 'cool-down active', competitorBelowFloor };
  }
  let target = ref != null ? ref - i.undercutSek : i.currentPrice;
  let reason = ref != null ? `align to competitor ${ref}` : 'no competitor data';
  if (target < floor) { target = floor; reason = `competitor ${ref} below floor — holding at floor ${floor} (no price war)`; }
  if (target > ceiling) { target = ceiling; reason += `; capped at ceiling ${ceiling}`; }

  const maxStep = i.currentPrice * i.maxChangePct / 100;
  if (Math.abs(target - i.currentPrice) > maxStep) {
    target = target > i.currentPrice ? i.currentPrice + maxStep : i.currentPrice - maxStep;
    reason += ` (step-limited ${i.maxChangePct} %)`;
  }
  let newPrice = Math.ceil(target);
  if (newPrice < floor) newPrice = floor;
  if (newPrice > ceiling) newPrice = ceiling;
  const changed = Math.abs(newPrice - i.currentPrice) >= 1;
  return { newPrice: changed ? newPrice : i.currentPrice, changed, reason: changed ? reason : 'no meaningful change', competitorBelowFloor };
}

/** Inventory exposure (section 10). */
export function listedQuantity(stock: number, safety: number, buffer: number, maxQty: number): { qty: number; pause: boolean; reason: string } {
  if (stock <= safety) return { qty: 0, pause: true, reason: stock <= 0 ? 'supplier out of stock' : `supplier stock ${stock} ≤ safety ${safety}` };
  if (stock < buffer) return { qty: Math.max(1, Math.min(2, stock - safety)), pause: false, reason: `low stock ${stock} < buffer ${buffer} — reduced quantity` };
  return { qty: Math.min(maxQty, Math.floor((stock - safety) / 2)), pause: false, reason: 'normal' };
}
