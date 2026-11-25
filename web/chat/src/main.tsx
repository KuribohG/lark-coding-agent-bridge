import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';
import { Api } from './lib/api';
import { browserRoute, takeToken } from './lib/browser';
import { Session } from './lib/session';
import { SessionContext } from './lib/use-session';

const session = new Session(new Api(takeToken()), browserRoute);
void session.start();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SessionContext.Provider value={session}>
      <App />
    </SessionContext.Provider>
  </StrictMode>,
);
