---
layout: post
title: A practical guide to browser tab isolation in React Router v7
author: Greg Baker
date: 2025-09-05
categories: react-router browser
---

Here's a bug you've probably run into, even if you didn't know what to call it. A user opens your app in two tabs. They
start filling out a form in the first tab, switch to the second tab to look something up, and come back to find the first
tab showing data from the second one. Their work is gone.

We call this *data clobbering*: one tab writes over the other tab's data. In this post I'll walk through how we fixed it
with a small React hook called `useTabId`.

## Why it happens

Most apps keep some state outside the page itself. It might live in a server-side session, in a cookie, or in
`localStorage`. The catch is that all of those are shared by every tab in the browser. If both tabs save their form data
under the same key, whichever tab saves last wins.

The app has no way to tell the two tabs apart, so it treats them like one.

## The fix: give each tab its own ID

If every tab has its own ID, we can include that ID in our storage keys, and the tabs stop stepping on each other.

The browser already gives us a good place to keep that ID: `sessionStorage`. Unlike `localStorage`, each tab gets its own
copy of `sessionStorage`. It also survives a page reload, so the ID stays the same for as long as the tab is open.

## The hook

Here's the core of `useTabId`:

```tsx
import { useEffect, useSyncExternalStore } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { randomString } from '~/utils/string-utils';

export const SEARCH_PARAM_KEY = 'tid';
export const SESSION_STORAGE_KEY = 'tab-id';

function generateRandomId(): string {
  const prefix = randomString(2, 'abcdefghijklmnopqrstuvwxyz');
  const suffix = randomString(4, '0123456789');
  return `${prefix}-${suffix}`;
}

function getSnapshot(sessionStorageKey: string): string {
  const id = window.sessionStorage.getItem(sessionStorageKey) ?? generateRandomId();
  window.sessionStorage.setItem(sessionStorageKey, id);
  return id;
}

function subscribe(sessionStorageKey: string, callback: () => void): () => void {
  const handler = ({ key }: StorageEvent): void => {
    if (key === sessionStorageKey) {
      callback();
    }
  };

  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
}

export function useTabId(options?: Options): string | undefined {
  // ... (options handling)

  const id = useSyncExternalStore(
    (callback) => subscribe(sessionStorageKey, callback),
    () => getSnapshot(sessionStorageKey),
    () => idSearchParam ?? undefined,
  );

  // ... (URL synchronization logic)

  return id;
}
```

There isn't much to it. Taking it one piece at a time:

- `generateRandomId` makes a short ID like `kq-4821`. It doesn't need to be globally unique, just different enough that
  two tabs open at the same time won't get the same one. Keeping it short and readable also makes it easier to spot in
  logs and URLs when you're debugging.
- `getSnapshot` looks for an ID in `sessionStorage`. If there isn't one yet, it makes one and saves it. Either way, you
  get the same ID back every time you call it in that tab.
- `subscribe` listens for the browser's `storage` event so that if the stored ID ever changes, React knows to re-render.

These three pieces are wired together with `useSyncExternalStore`. That's React's built-in hook for reading a value that
lives outside of React (here, `sessionStorage`) and keeping your component up to date with it. You give it a function to
subscribe to changes, a function to read the current value, and a function to use during server rendering.

That last one matters. When the page is rendered on the server there's no `window` and no `sessionStorage`, so the hook
can't read the ID from there. Instead it falls back to the `tid` value in the URL's query string (`?tid=kq-4821`). The
parts of the hook I left out above handle keeping that query parameter in sync with the stored ID, so the server and the
browser end up agreeing on which tab is which.

## Using it

In a component, it looks like this:

```tsx
import { useTabId } from '~/hooks/use-tab-id';

function MyComponent() {
  const tabId = useTabId();

  // Use the tabId to create a unique key for your data
  const sessionDataKey = `my-app-data-${tabId}`;

  // ... (your component logic)
}
```

The only change from what you'd normally write is that the tab ID is now part of the key. Tab A saves to
`my-app-data-kq-4821`, tab B saves to `my-app-data-xd-0937`, and neither one can overwrite the other.

## A few tips

- **Use it everywhere you store per-tab data.** If one component uses the tab ID and another doesn't, you've still got
  the bug, it's just harder to find.
- **Don't build more than you need.** For most apps, an ID in `sessionStorage` is enough. You probably don't need to
  coordinate between tabs or track which tabs are open.
- **Test it with real tabs.** Open the app in two tabs, do different things in each, and make sure nothing leaks
  between them. Also try reloading a tab to check that it keeps its ID.
- **Watch out for "Duplicate tab".** Most browsers copy `sessionStorage` when you duplicate a tab, so the new tab
  starts out with the same ID as the original. Keep that in mind if it matters for your app.

## Wrapping up

Multi-tab bugs are annoying because they're hard to reproduce and they make users lose work. Giving each tab its own ID
is a small change that fixes a whole class of them. If your app stores anything a user would be upset to lose, it's worth
adding.
