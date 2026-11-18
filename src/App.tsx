// Loads the catalogue and the user's saved setup, then picks the screen:
// no cards saved yet -> setup; otherwise -> till (where "Setup" goes back to setup).

import { useEffect, useState } from 'react';
import { fetchCatalogue } from './catalogue.ts';
import { SetupScreen } from './components/SetupScreen.tsx';
import { TillScreen } from './components/TillScreen.tsx';
import { getPreferences, listCards } from './db/db.ts';
import type { Catalogue, UserPreferences } from './engine/types.ts';

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; catalogue: Catalogue; cardIds: string[]; preferences: UserPreferences; screen: 'setup' | 'till' };

export default function App() {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchCatalogue(), listCards(), getPreferences()])
      .then(([catalogue, saved, preferences]) => {
        if (cancelled) return;
        // Ignore saved cards that are no longer in the catalogue, so ranking never sees an unknown card.
        const cardIds = saved.map((c) => c.cardId).filter((id) => catalogue.cards.some((c) => c.id === id));
        setState({ status: 'ready', catalogue, cardIds, preferences, screen: cardIds.length > 0 ? 'till' : 'setup' });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ status: 'error', message: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === 'loading') {
    return (
      <main>
        <p className="status" role="status">
          Loading…
        </p>
      </main>
    );
  }

  if (state.status === 'error') {
    return (
      <main>
        <section className="screen">
          <h1>Something went wrong</h1>
          <p className="error" role="alert">
            {state.message}
          </p>
          <div className="actions">
            <button type="button" className="primary" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
        </section>
      </main>
    );
  }

  const { catalogue, cardIds, preferences, screen } = state;
  return (
    <main>
      {screen === 'setup' ? (
        <SetupScreen
          catalogue={catalogue}
          initialCardIds={cardIds}
          initialPreferences={preferences}
          onSaved={(savedIds, savedPreferences) =>
            setState({ ...state, cardIds: savedIds, preferences: savedPreferences, screen: 'till' })
          }
          onCancel={cardIds.length > 0 ? () => setState({ ...state, screen: 'till' }) : undefined}
        />
      ) : (
        <TillScreen catalogue={catalogue} preferences={preferences} onChangeSetup={() => setState({ ...state, screen: 'setup' })} />
      )}
    </main>
  );
}
