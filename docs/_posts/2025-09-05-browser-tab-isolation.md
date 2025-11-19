---
layout: post
title: A practical guide to browser tab isolation in React Router v7
author: Greg Baker
date: 2025-09-05
categories: react-router browser
---

If you've built a complex web app, you've likely seen it: a user has multiple tabs open, and suddenly data from one tab
overwrites data in another. This frustrating issue, known as data clobbering, can corrupt user data and wreck the user
experience.

This is where browser tab isolation comes in. This post introduces a powerful technique for isolating tabs in React applications
using a custom hook called `useTabId`. We'll break down how it works and how you can implement it in your own projects.

## The Problem: Data Clobbering in a Multi-Tab World

Imagine a user filling out a long form. They open a new tab to check some information, and when they return, their form data is
gone, replaced by the state of the other tab. This happens when an application uses a shared storage mechanism, like a
server-side session or `localStorage`, without distinguishing between tabs. The application treats all tabs as one, leading to
data collisions.

## The Solution: A Unique Identifier for Each Tab

To fix this, each browser tab needs a unique identifier. The `useTabId` hook does just that. It generates a unique, persistent
ID for each tab and stores it in `sessionStorage`. Since `sessionStorage` is scoped to a single tab, each tab gets its own
isolated data context.

### How it Works: A Look Under the Hood

The `useTabId` hook uses React's `useSyncExternalStore` to keep the tab ID in sync between `sessionStorage` and your component's
state. Here's a look at the implementation:

```typescript
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

The hook's logic is straightforward:

1.  **Generate a unique ID:** `generateRandomId` creates a random, human-readable ID.
2.  **Store the ID in `sessionStorage`:** `getSnapshot` gets the current tab ID from `sessionStorage` or creates a new one. This
    makes the ID persist through page reloads in the same tab.
3.  **Subscribe to changes:** `subscribe` listens for changes to the tab ID in `sessionStorage`. If the ID changes,
    `useSyncExternalStore` triggers a re-render, ensuring the component always has the latest ID.

### Putting it all Together: Using the `useTabId` Hook

Here's how to use the `useTabId` hook in a React component:

```typescript
import { useTabId } from '~/hooks/use-tab-id';

function MyComponent() {
  const tabId = useTabId();

  // Use the tabId to create a unique key for your data
  const sessionDataKey = `my-app-data-${tabId}`;

  // ... (your component logic)
}
```

By including the `tabId` in your data keys, you give each tab its own storage space. This prevents data clobbering and ensures a
consistent user experience.

## Beyond the Basics: URL Synchronization and Best Practices

A few best practices for using `useTabId`:

*   **Be consistent:** Use the `useTabId` hook in all components that handle tab-specific data.
*   **Keep it simple:** The `useTabId` hook is a simple solution. Don't over-engineer your tab isolation logic.
*   **Test thoroughly:** As with any critical feature, make sure to test your implementation to ensure it works as expected.

## Conclusion

Browser tab isolation is essential for building robust web applications. With a custom hook like `useTabId`, you can easily
isolate data between tabs, prevent data clobbering, and create a better user experience. Give it a try in your next project!
