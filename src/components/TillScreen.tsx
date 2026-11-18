// The till: say where you're paying and how much, see your cards ranked with why (and a link to the terms),
// then log the card you paid with.

import { useEffect, useMemo, useRef, useState } from 'react';
import { listCards, logPurchase, recentShopIds } from '../db/db.ts';
import { rank } from '../engine/rank.ts';
import { CATEGORIES, type Card, type Catalogue, type Category, type RankedCard, type Shop, type UserCard, type UserPreferences } from '../engine/types.ts';
import { CATEGORY_LABELS, formatMoney, formatReward, parseAmount, searchShops, todayLocal } from '../till.ts';

interface Props {
  catalogue: Catalogue;
  preferences: UserPreferences;
  onChangeSetup: () => void;
}

// Where the user is paying: a shop from the catalogue, or a category they picked for a shop that isn't listed.
type Place = { shop: Shop } | { category: Category };

export function TillScreen({ catalogue, preferences, onChangeSetup }: Props) {
  const [userCards, setUserCards] = useState<UserCard[] | null>(null);
  const [recent, setRecent] = useState<Shop[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [pickingCategory, setPickingCategory] = useState(false);
  const [place, setPlace] = useState<Place | null>(null);
  const [amountText, setAmountText] = useState('');
  const [foreign, setForeign] = useState(false);

  const [loggingCardId, setLoggingCardId] = useState<string | null>(null);
  const [logged, setLogged] = useState<string | null>(null);
  const [logError, setLogError] = useState<string | null>(null);

  const amountRef = useRef<HTMLInputElement>(null);

  const loadRecent = async () => {
    const ids = await recentShopIds();
    setRecent(ids.map((id) => catalogue.shops.find((s) => s.id === id)).filter((s): s is Shop => s !== undefined));
  };

  useEffect(() => {
    let cancelled = false;
    Promise.all([listCards(), recentShopIds()])
      .then(([cards, ids]) => {
        if (cancelled) return;
        // Skip saved cards that are no longer in the catalogue, so rank() never sees an unknown card.
        setUserCards(cards.filter((c) => catalogue.cards.some((k) => k.id === c.cardId)));
        setRecent(ids.map((id) => catalogue.shops.find((s) => s.id === id)).filter((s): s is Shop => s !== undefined));
      })
      .catch(() => {
        if (!cancelled) setLoadError('Your cards could not be read from this device. Try reloading the page.');
      });
    return () => {
      cancelled = true;
    };
  }, [catalogue]);

  const amountPence = parseAmount(amountText);
  const date = todayLocal();

  const results = useMemo(() => {
    if (!place || amountPence === null || !userCards) return null;
    return rank({
      catalogue,
      purchase: {
        amountPence,
        ...('shop' in place ? { shopId: place.shop.id } : { category: place.category }),
        foreignCurrency: foreign,
        date,
      },
      userCards,
      preferences,
    });
  }, [catalogue, preferences, userCards, place, amountPence, foreign, date]);

  const choose = (next: Place) => {
    setPlace(next);
    setQuery('');
    setPickingCategory(false);
    setLogged(null);
    // Straight on to the amount, so a repeat visit is: tap the shop, type the amount.
    requestAnimationFrame(() => amountRef.current?.focus());
  };

  const clearPlace = () => {
    setPlace(null);
    setLogged(null);
  };

  async function paidWith(result: RankedCard) {
    if (!place || amountPence === null) return;
    const card = catalogue.cards.find((c) => c.id === result.cardId)!;
    setLoggingCardId(result.cardId);
    setLogError(null);
    try {
      await logPurchase({
        date,
        amountPence,
        ...('shop' in place ? { shopId: place.shop.id, category: place.shop.category } : { category: place.category }),
        foreignCurrency: foreign,
        cardId: result.cardId,
        ruleId: result.ruleId,
        currencyId: result.currencyId,
        rewardUnits: result.rewardUnits,
        valuePence: result.valuePence,
      });
      const where = 'shop' in place ? place.shop.name : CATEGORY_LABELS[place.category].toLowerCase();
      setLogged(`Logged ${formatMoney(amountPence)} at ${where} with ${card.name}.`);
      setPlace(null);
      setAmountText('');
      setForeign(false);
      await loadRecent();
    } catch {
      setLogError('That purchase could not be saved on this device. Please try again.');
    } finally {
      setLoggingCardId(null);
    }
  }

  const matches = searchShops(catalogue.shops, query);
  const amountInvalid = amountText.trim() !== '' && amountPence === null;

  return (
    <section className="screen till">
      <header className="till-header">
        <h1>Which card?</h1>
        <button type="button" onClick={onChangeSetup}>
          Setup
        </button>
      </header>

      {logged && (
        <p className="notice" role="status">
          {logged}
        </p>
      )}
      {loadError && (
        <p className="error" role="alert">
          {loadError}
        </p>
      )}

      <div className="field">
        <span className="field-label" id="where-label">
          Where are you paying?
        </span>

        {place ? (
          <div className="chosen">
            <span>
              <strong>{'shop' in place ? place.shop.name : CATEGORY_LABELS[place.category]}</strong>
              <small>{'shop' in place ? CATEGORY_LABELS[place.shop.category] : 'Shop not listed'}</small>
            </span>
            <button type="button" onClick={clearPlace}>
              Change
            </button>
          </div>
        ) : pickingCategory ? (
          <>
            <label className="field-label" htmlFor="category">
              What are you buying?
            </label>
            <select
              id="category"
              value=""
              onChange={(e) => e.target.value && choose({ category: e.target.value as Category })}
            >
              <option value="">Choose a category</option>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
            <button type="button" className="link" onClick={() => setPickingCategory(false)}>
              Back to shop search
            </button>
          </>
        ) : (
          <>
            <input
              type="search"
              aria-labelledby="where-label"
              placeholder="Search shops, e.g. Tesco"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setLogged(null);
              }}
              autoComplete="off"
              enterKeyHint="search"
            />
            {query.trim() === '' ? (
              recent.length > 0 && (
                <div className="shop-list" role="group" aria-label="Recent shops">
                  <span className="hint">Recent</span>
                  {recent.map((shop) => (
                    <button type="button" key={shop.id} className="chip" onClick={() => choose({ shop })}>
                      {shop.name}
                    </button>
                  ))}
                </div>
              )
            ) : (
              <div className="shop-list" role="group" aria-label="Matching shops">
                {matches.length === 0 && <span className="hint">No shops match “{query.trim()}”.</span>}
                {matches.map((shop) => (
                  <button type="button" key={shop.id} className="chip" onClick={() => choose({ shop })}>
                    {shop.name}
                  </button>
                ))}
              </div>
            )}
            <button type="button" className="link" onClick={() => setPickingCategory(true)}>
              Not listed? Choose a category
            </button>
          </>
        )}
      </div>

      <div className="field">
        <label className="field-label" htmlFor="amount">
          Amount
        </label>
        <div className="money-input">
          <span aria-hidden="true">£</span>
          <input
            id="amount"
            ref={amountRef}
            type="text"
            inputMode="decimal"
            enterKeyHint="done"
            autoComplete="off"
            placeholder="0.00"
            value={amountText}
            onChange={(e) => {
              setAmountText(e.target.value);
              setLogged(null);
            }}
            aria-invalid={amountInvalid}
            aria-describedby={amountInvalid ? 'amount-hint' : undefined}
          />
        </div>
        {amountInvalid && (
          <span className="hint error-text" id="amount-hint">
            Enter an amount like 12.50
          </span>
        )}
      </div>

      <label className="option">
        <input type="checkbox" checked={foreign} onChange={(e) => setForeign(e.target.checked)} />
        <span>
          <strong>Paying in a foreign currency</strong>
          <small>Each card’s value is its reward minus its foreign transaction fee, so the best card may just be the one that costs least.</small>
        </span>
      </label>

      {logError && (
        <p className="error" role="alert">
          {logError}
        </p>
      )}

      {results && (
        <ol className="results" aria-label="Your cards, best first">
          {results.map((result, i) => (
            <ResultCard
              key={result.cardId}
              result={result}
              catalogue={catalogue}
              best={i === 0 && isBest(results)}
              foreign={foreign}
              logging={loggingCardId !== null}
              onPaid={() => paidWith(result)}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

interface ResultProps {
  result: RankedCard;
  catalogue: Catalogue;
  best: boolean;
  foreign: boolean;
  logging: boolean;
  onPaid: () => void;
}

// The top card gets "Best" when it beats every other card the shop takes, even at 0p: abroad,
// a card with no fee that earns nothing still beats cards whose fee costs more than they earn.
// With no other card to compare (or a tie), it only gets "Best" if it actually earns something.
function isBest(results: RankedCard[]): boolean {
  const [top, ...rest] = results.filter((r) => r.acceptance !== 'no');
  if (!top || top !== results[0]) return false;
  const next = rest[0];
  return next ? top.valuePence > next.valuePence : top.valuePence > 0;
}

function ResultCard({ result, catalogue, best, foreign, logging, onPaid }: ResultProps) {
  const card = catalogue.cards.find((c) => c.id === result.cardId)!;
  const currency = catalogue.currencies.find((c) => c.id === result.currencyId)!;
  const rule = result.ruleId ? card.rules.find((r) => r.id === result.ruleId) : undefined;
  // Links to the card's published terms for this rule (or the card, if no rule matched).
  const termsUrls = (rule ?? card).verification.sourceUrls;

  return (
    <li className={`result${best ? ' best' : ''}${result.acceptance === 'no' ? ' declined' : ''}`}>
      <div className="result-head">
        <span>
          {best && <span className="badge">Best</span>}
          <strong className="result-name">{card.name}</strong>
        </span>
        <span className="result-value">{formatMoney(result.valuePence)}</span>
      </div>

      <p className="result-reward">
        {formatReward(result.rewardUnits, currency)}
        {!result.isCash && result.rewardUnits > 0 && ` (about ${formatMoney(result.rewardValuePence)} for your goal)`}
      </p>

      {foreign && (
        <p className={`result-fee${result.feePence > 0 ? ' has-fee' : ''}`}>
          {result.feePence > 0
            ? `Foreign fee ${card.foreignTransactionFeePercent}%: ${formatMoney(-result.feePence)}`
            : 'No foreign fee'}
        </p>
      )}

      <p className="result-reason">
        <span className="result-label">Why: </span>
        {reasonText(rule?.description, result, card)}
      </p>

      {termsUrls.length > 0 && (
        <p className="result-terms">
          {termsUrls.map((url, n) => (
            <span key={url}>
              {n > 0 && ' · '}
              <a href={url} target="_blank" rel="noopener noreferrer">
                {termsUrls.length > 1 ? `Terms ${n + 1}` : 'Terms'}
              </a>
            </span>
          ))}
        </p>
      )}

      {result.warnings.length > 0 && (
        <ul className="warnings" aria-label="Warnings">
          {result.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      <button type="button" className={best ? 'primary' : ''} disabled={logging} onClick={onPaid}>
        Paid with this
      </button>
    </li>
  );
}

function reasonText(description: string | undefined, result: RankedCard, card: Card): string {
  const parts = [description ?? `No reward rule on the ${card.name} matches this purchase.`];
  if (result.offerIds.length > 0) parts.push('Includes a shop offer.');
  if (result.capped && result.rewardUnits > 0) parts.push('Part of this purchase is over the reward cap.');
  return parts.join(' ');
}
