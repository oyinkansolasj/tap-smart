// Setup: pick what rewards are for (the goal), tick the cards you have, and save.

import { useId, useState, type FormEvent } from 'react';
import { saveSetup } from '../db/db.ts';
import { formatPounds } from '../engine/rank.ts';
import type { Card, CardIssuer, Catalogue, Goal, GoalKind, UserPreferences } from '../engine/types.ts';

const ISSUER_NAMES: Record<CardIssuer, string> = { natwest: 'NatWest', revolut: 'Revolut', amex: 'American Express' };

// How much extra a point in the chosen currency is worth to the user, on top of its £ value.
const BOOST_CHOICES = [0, 10, 25, 50, 100];
const DEFAULT_BOOST = 25;

interface Props {
  catalogue: Catalogue;
  initialCardIds: string[];
  initialPreferences: UserPreferences;
  onSaved: (cardIds: string[], preferences: UserPreferences) => void;
  // Only given when changing an existing setup, so a first-time user can't skip it.
  onCancel?: () => void;
}

export function SetupScreen({ catalogue, initialCardIds, initialPreferences, onSaved, onCancel }: Props) {
  const id = useId();
  const collectable = catalogue.currencies.filter((c) => c.kind !== 'cash');
  const initialGoal = initialPreferences.goal;

  const [goalKind, setGoalKind] = useState<GoalKind>(
    initialGoal.kind === 'collect_currency' && collectable.length === 0 ? 'max_value' : initialGoal.kind,
  );
  const [targetId, setTargetId] = useState(
    collectable.find((c) => c.id === initialGoal.targetCurrencyId)?.id ?? collectable[0]?.id ?? '',
  );
  const [boost, setBoost] = useState(initialGoal.boostPercent ?? DEFAULT_BOOST);
  // Only cards that are still in the catalogue can be ticked.
  const [selected, setSelected] = useState(
    () => new Set(initialCardIds.filter((cardId) => catalogue.cards.some((c) => c.id === cardId))),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const boostChoices = BOOST_CHOICES.includes(boost) ? BOOST_CHOICES : [...BOOST_CHOICES, boost].sort((a, b) => a - b);

  const toggle = (cardId: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(cardId);
      else next.delete(cardId);
      return next;
    });

  // For pick-one groups (Revolut plans): untick the whole group, then tick the chosen plan.
  const choosePlan = (group: Card[], cardId: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const c of group) next.delete(c.id);
      if (cardId) next.add(cardId);
      return next;
    });

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (selected.size === 0) {
      setError('Tick at least one card.');
      return;
    }
    const goal: Goal =
      goalKind === 'collect_currency' ? { kind: goalKind, targetCurrencyId: targetId, boostPercent: boost } : { kind: goalKind };
    const preferences: UserPreferences = { goal, pencePerUnitOverrides: initialPreferences.pencePerUnitOverrides };
    // Keep the catalogue's order so the saved list is stable.
    const cardIds = catalogue.cards.filter((c) => selected.has(c.id)).map((c) => c.id);

    setError(null);
    setSaving(true);
    try {
      await saveSetup(cardIds, preferences);
      onSaved(cardIds, preferences);
    } catch {
      setError('Your setup could not be saved on this device. Check the browser is not in private mode, then try again.');
      setSaving(false);
    }
  }

  return (
    <form className="screen" onSubmit={handleSubmit} noValidate>
      <h1>Set up</h1>
      <p className="lede">Tell us what your rewards are for and which cards you carry. This stays on your device.</p>

      <fieldset>
        <legend>What are your rewards for?</legend>

        <label className="option">
          <input type="radio" name={`${id}-goal`} value="max_value" checked={goalKind === 'max_value'} onChange={() => setGoalKind('max_value')} />
          <span>
            <strong>Most value</strong>
            <small>Points count at their estimated £ value, so they compete with cashback.</small>
          </span>
        </label>

        <label className="option">
          <input type="radio" name={`${id}-goal`} value="cash_only" checked={goalKind === 'cash_only'} onChange={() => setGoalKind('cash_only')} />
          <span>
            <strong>Cash only</strong>
            <small>Only cashback counts. Points are treated as worth nothing.</small>
          </span>
        </label>

        {collectable.length > 0 && (
          <label className="option">
            <input
              type="radio"
              name={`${id}-goal`}
              value="collect_currency"
              checked={goalKind === 'collect_currency'}
              onChange={() => setGoalKind('collect_currency')}
            />
            <span>
              <strong>Collect one kind of points</strong>
              <small>Favour cards that earn, or transfer into, the points you are saving up.</small>
            </span>
          </label>
        )}

        {goalKind === 'collect_currency' && (
          <div className="goal-details">
            <label>
              Points to collect
              <select value={targetId} onChange={(e) => setTargetId(e.target.value)}>
                {collectable.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              How much more they are worth to you
              <select value={boost} onChange={(e) => setBoost(Number(e.target.value))}>
                {boostChoices.map((b) => (
                  <option key={b} value={b}>
                    {b === 0 ? 'No extra' : `${b}% extra`}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
      </fieldset>

      <fieldset>
        <legend>Which cards do you have?</legend>
        {groupByIssuer(catalogue.cards).map(({ issuer, cards, pickOne }) => (
          <div className="card-group" key={issuer}>
            <h2>{ISSUER_NAMES[issuer]}</h2>
            {pickOne ? (
              <>
                <p className="hint">You can only have one {ISSUER_NAMES[issuer]} plan.</p>
                <label className="option">
                  <input
                    type="radio"
                    name={`${id}-${issuer}`}
                    value=""
                    checked={!cards.some((c) => selected.has(c.id))}
                    onChange={() => choosePlan(cards, '')}
                  />
                  <span>
                    <strong>None</strong>
                  </span>
                </label>
                {cards.map((card) => (
                  <label className="option" key={card.id}>
                    <input
                      type="radio"
                      name={`${id}-${issuer}`}
                      value={card.id}
                      checked={selected.has(card.id)}
                      onChange={() => choosePlan(cards, card.id)}
                    />
                    <CardLabel card={card} />
                  </label>
                ))}
              </>
            ) : (
              cards.map((card) => (
                <label className="option" key={card.id}>
                  <input type="checkbox" checked={selected.has(card.id)} onChange={(e) => toggle(card.id, e.target.checked)} />
                  <CardLabel card={card} />
                </label>
              ))
            )}
          </div>
        ))}
      </fieldset>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="actions">
        <button type="submit" className="primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

function CardLabel({ card }: { card: Card }) {
  return (
    <span>
      <strong>{card.name}</strong>
      <small>
        {card.type === 'credit' ? 'Credit card' : 'Debit card'} · {feeText(card)}
      </small>
    </span>
  );
}

function feeText(card: Card): string {
  const { annualFeePence, monthlyFeePence } = card.fees;
  if (annualFeePence > 0) return `${formatPounds(annualFeePence)} a year`;
  if (monthlyFeePence > 0) return `${formatPounds(monthlyFeePence)} a month`;
  return 'No fee';
}

// Cards grouped by issuer, in catalogue order. An issuer whose cards are all plans (Revolut Standard,
// Plus, ...) is pick-one, because an account can only be on one plan at a time.
function groupByIssuer(cards: Card[]): { issuer: CardIssuer; cards: Card[]; pickOne: boolean }[] {
  const groups = new Map<CardIssuer, Card[]>();
  for (const card of cards) groups.set(card.issuer, [...(groups.get(card.issuer) ?? []), card]);
  return [...groups].map(([issuer, group]) => ({ issuer, cards: group, pickOne: group.length > 1 && group.every((c) => c.plan) }));
}
