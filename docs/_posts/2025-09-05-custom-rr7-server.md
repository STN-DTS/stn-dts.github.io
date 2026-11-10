---
layout: post
title: Building a custom express server for a React Router v7 application
author: Greg Baker
date: 2025-09-05
categories: react-router server
---

React Router v7 ships with its own server, and for a lot of apps that's all you need. We wanted more control, though. We
wanted to decide exactly how each request is handled, and we wanted to plug in our own Express middleware for things like
logging, security headers and sessions. (Middleware is a function that runs on every request before your app's code does.)

So we wrote our own Express server. This post walks through how ours is put together. It's written in TypeScript, and all
of the server code lives in the `app/.server/` directory.

## Project layout

There's no single right way to lay this out, but we like keeping server code apart from client code. Everything for the
server lives under `app/.server/`:

```
app/
└── .server/
    ├── express/
    │   ├── assets/
    │   │   ├── 403.html
    │   │   └── 500.html
    │   ├── handlers.ts
    │   ├── middleware.ts
    │   └── server.ts
    └── ... (other server-related files like environment configurations, logging utilities, etc.)
```

Here's what each piece does:

*   `app/.server/express/` holds the whole Express server.
*   `app/.server/express/assets/` holds static files the server sends directly, like our custom error pages.
*   `app/.server/express/handlers.ts` defines the request handlers and the error handling. It's the bridge between an
    incoming request and the response your app sends back.
*   `app/.server/express/middleware.ts` holds our custom Express middleware, for things like logging and security headers.
*   `app/.server/express/server.ts` is the entry point. It creates the Express app, applies the middleware and starts the
    server.

## Building the server with Vite

We build the server with Vite. It has its own config file, `vite.server.config.ts`, separate from the client config, so
each build can be tuned on its own.

```typescript
import type { Plugin } from 'vite';
import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  build: {
    // Prevents Vite from copying the `public` directory. For server builds,
    // static assets are typically handled differently or are not needed.
    copyPublicDir: false,

    // Ensures that the `outDir` is not cleared before building. This is crucial
    // when you have multiple build processes (e.g., client and server) writing
    // to the same base output directory, preventing one build from deleting
    // the output of another.
    emptyOutDir: false,

    // Specifies the output directory for the server build. In this case,
    // the server-side bundles will be placed in `./build/server/`.
    outDir: './build/server/',

    rollupOptions: {
      // Defines the entry points for the server bundle. This tells Rollup (Vite's
      // underlying bundler) where to start building the server code.
      input: ['./app/.server/telemetry.ts', './app/.server/express/server.ts'],
    },

    // Enables Server-Side Rendering (SSR) mode. This optimizes the build
    // for Node.js environments, ensuring that server-specific code is
    // correctly bundled and executed.
    ssr: true,

    // Specifies the target environment for the compiled JavaScript.
    // 'node22' ensures compatibility with Node.js version 22, allowing
    // the use of modern JavaScript features available in that environment.
    target: 'node22',
  },
  plugins: [
    // Custom plugin to handle `import.meta.url` for logging purposes.
    // This ensures that log messages correctly report the originating file path
    // even after the code has been bundled.
    preserveImportMetaUrl(),

    // Integrates TypeScript path aliasing. This plugin resolves paths defined
    // in your `tsconfig.json` (e.g., `~/.server/`) to their actual file paths,
    // making imports cleaner and more manageable.
    tsconfigPaths(),

    // A plugin to copy static assets. In this setup, it copies the contents
    // of `./app/.server/express/assets/` (which includes our error pages)
    // to the root of the build output directory.
    viteStaticCopy({
      targets: [{ src: './app/.server/express/assets/', dest: './' }],
    }),
  ],
});

/**
 * This custom Vite plugin is designed to modify how `import.meta.url` is handled
 * within the bundled server code. In a typical Node.js environment, `import.meta.url`
 * provides the full URL of the current module. However, after bundling, this information
 * might become less useful for logging purposes, as it would point to the bundled file
 * rather than the original source file.
 *
 * This `preserveImportMetaUrl` plugin intercepts calls to `getLogger(import.meta.url)`
 * and replaces `import.meta.url` with a more meaningful, project-relative path.
 * This allows the logging subsystem to accurately identify the source file of a log
 * message, which is invaluable for debugging and monitoring in a production environment.
 *
 * @returns A Vite Plugin object.
 */
export function preserveImportMetaUrl(): Plugin {
  return {
    name: 'preserve-import-meta-url',
    transform(code, id) {
      // If the file path contains 'app/', truncate it to start from 'app/'
      // otherwise, use the full ID. This creates a more readable path for logs.
      const truncatedPath = id.includes('app/') ? id.slice(id.indexOf('app/')) : id;
      // Replace the getLogger call with the truncated path, ensuring it's
      // correctly stringified for the generated JavaScript.
      return code.replace(/getLogger\(import\.meta\.url\)/g, `getLogger(${JSON.stringify(truncatedPath)})`);
    },
  };
}
```

This tells Vite to build in SSR (server-side rendering) mode, with `app/.server/express/server.ts` as one of the entry
points. It also copies static assets, like the error pages, into the build output.

## Building the application

There are two builds: one for the client-side app and one for the server. In our `package.json` they're called
`build:application` and `build:server`.

`build:application` builds the React app that runs in the browser. It compiles your components, TypeScript and CSS into
bundles the browser can load, and usually minifies them along the way.

`build:server` builds the Express server. It compiles the TypeScript server code into JavaScript that Node.js can run, and
copies over any static files the server needs, like our error pages.

You can run them one at a time, but it's easier to have a `build` script that runs both:

```json
"scripts": {
  "build": "pnpm run build:application && pnpm run build:server",
  "build:application": "react-router build",
  "build:server": "vite build --config ./vite.server.config.ts"
}
```

When the build finishes, the client files end up in a folder like `build/client/` and the server code in `build/server/`.

## The Express server

The main server file is `app/.server/express/server.ts`. It creates the Express app, sets a few global options, applies
the middleware and starts listening for requests.

```typescript
import compression from 'compression';
import express from 'express';
import type { AddressInfo } from 'node:net';

import { clientEnvironment, serverEnvironment } from '~/.server/environment';
import { globalErrorHandler, rrRequestHandler } from '~/.server/express/handlers';
import { logging, security, session, tracing } from '~/.server/express/middleware';
import { createViteDevServer } from '~/.server/express/vite';
import { LogFactory } from '~/.server/logging';

const log = LogFactory.getLogger(import.meta.url);

// Make client-side environment variables available globally. Client side variables are exposed
// in this way on the client, so replicating that on the server makes referencing these variables
// consistent across both client and server.
globalThis.__appEnvironment = clientEnvironment;

// In a development environment, we integrate with Vite's development server
// to enable features like Hot Module Replacement (HMR) and efficient asset serving.
const viteDevServer = await createViteDevServer(serverEnvironment);
const app = express(); // Initialize the Express application.

// Disable the 'X-Powered-By' header for security reasons. This header
// can reveal that your application is built with Express, potentially
// providing information to attackers.
app.disable('x-powered-by');

// Enable 'trust proxy' when the application is running behind a reverse proxy
// (e.g., Nginx, Load Balancer). This ensures that Express correctly
// interprets the client's IP address from the 'X-Forwarded-For' header.
app.set('trust proxy', true);

///
///
/// Apply various middleware in a specific order. The order of middleware
/// is crucial as they process requests sequentially.
///
///

// Tracing middleware should typically be applied early to capture
// the entire request lifecycle for observability.
app.use(tracing());

// Compression middleware compresses response bodies, reducing the amount
// of data transferred and improving load times. It's generally applied early.
app.use(compression());

// Logging middleware for recording incoming requests.
app.use(logging(serverEnvironment));

// Security middleware to set various HTTP security headers.
app.use(security(serverEnvironment));

// Conditional serving of static assets based on the environment.
// In production, assets are served from the optimized build output with aggressive caching.
if (serverEnvironment.isProduction) {
  // Cache immutable assets (like those with content hashes) for a long time.
  app.use('/assets', express.static('./build/client/assets', { immutable: true, maxAge: '1y' }));
  // Serve other client-side build artifacts with long-term caching.
  app.use(express.static('./build/client', { maxAge: '1y' }));
} else {
  // In development, serve assets from the public directory with shorter cache times
  // to facilitate rapid development and iteration.
  app.use('/locales', express.static('./public/locales', { maxAge: '1m' }));
  app.use(express.static('./public', { maxAge: '1h' }));
}

// Session middleware for managing user sessions. This should be applied
// before any routes that require session access.
app.use(session(serverEnvironment));

// If a Vite development server is active (i.e., in development mode),
// integrate its middleware. This allows Vite to handle module requests
// and provide HMR capabilities.
if (viteDevServer) {
  app.use(viteDevServer.middlewares);
}

// The main request handler for React Router. This catches all remaining
// requests and delegates them to the React Router's SSR mechanism.
// The '*splat' syntax is used to match all paths in Express v5.
app.all('*splat', rrRequestHandler(viteDevServer));

// Global error handler. This should be the last middleware applied
// to catch any errors that occur during the request-response cycle.
app.use(globalErrorHandler());

// Start the Express server and listen on the configured port.
const server = app.listen(serverEnvironment.PORT);
log.info('Listening on http://localhost:%s/', (server.address() as AddressInfo).port);
```

## Middleware

Our custom middleware lives in `app/.server/express/middleware.ts`. Each function handles one job, so we can reuse it and
apply it to the Express app where we need it.

```typescript
import { trace } from '@opentelemetry/api';
import type { RequestHandler } from 'express';
import sessionMiddleware from 'express-session';
import { minimatch } from 'minimatch';
import morganMiddleware from 'morgan';
import { randomUUID } from 'node:crypto';

import type { ServerEnvironment } from '~/.server/environment';
import { createMemoryStore, createRedisStore } from '~/.server/express/session';
import { LogFactory } from '~/.server/logging';

/**
 * A helper function to determine if a given path should be ignored based on a list of glob patterns.
 * This is useful for selectively applying middleware to certain routes.
 */
function shouldIgnore(ignorePatterns: string[], path: string): boolean {
  return ignorePatterns.some((entry) => minimatch(path, entry));
}

/**
 * Configures a logging middleware using `morgan`. This middleware logs details
 * about incoming HTTP requests, which is invaluable for monitoring and debugging.
 * The log format adapts based on the environment (e.g., 'tiny' for production, 'dev' for development).
 * Certain paths can be ignored to prevent excessive logging of static assets or health checks.
 */
export function logging(environment: ServerEnvironment): RequestHandler {
  const ignorePatterns = [
    '/__manifest', // Example: ignore manifest file requests
    '/api/readyz',  // Example: ignore health check endpoints
    '/assets/**',   // Example: ignore all static asset requests
    '/favicon.ico', // Example: ignore favicon requests
  ];

  const logFormat = environment.isProduction ? 'tiny' : 'dev';

  const middleware = morganMiddleware(logFormat, {
    // The stream option directs morgan's output to our custom logging system.
    stream: { write: (str) => LogFactory.getLogger('morgan').audit(str.trim()) },
  });

  return (request, response, next) => {
    if (shouldIgnore(ignorePatterns, request.path)) {
      // If the path should be ignored, simply skip this middleware.
      return next();
    }
    // Otherwise, process the request with morgan.
    return middleware(request, response, next);
  };
}

/**
 * Sets various HTTP security headers to protect the application from common web vulnerabilities.
 * This includes Content Security Policy (CSP), Permissions Policy, and others.
 * A unique nonce is generated for each request to be used in the CSP, enhancing security against XSS attacks.
 */
export function security(environment: ServerEnvironment): RequestHandler {
  const ignorePatterns: string[] = [
    // Add paths to ignore security headers if necessary (e.g., for specific API endpoints).
  ];

  return (request, response, next) => {
    if (shouldIgnore(ignorePatterns, request.path)) {
      // Log that security headers are being skipped for this path (for debugging).
      LogFactory.getLogger('security').trace('Skipping adding security headers to response: [%s]', request.path);
      return next();
    }

    // Generate a unique nonce for each request. This nonce is used in the CSP
    // to allow only scripts with this nonce to execute, preventing injected scripts.
    response.locals.nonce = randomUUID();
    LogFactory.getLogger('security').trace('Adding nonce [%s] to response', response.locals.nonce);

    // Define the Content Security Policy. This is a critical security header
    // that controls which resources the user agent is allowed to load.
    const contentSecurityPolicy = [
      `base-uri 'none'`, // Disallows the use of <base> elements.
      `default-src 'none'`, // Default policy for fetching resources.
      `connect-src 'self'` + (environment.isProduction ? '' : ' ws://localhost:3001'), // Allows connections to self and WebSocket in dev.
      `font-src 'self' fonts.gstatic.com use.fontawesome.com www.canada.ca`, // Allows fonts from specified sources.
      `form-action 'self'`, // Restricts URLs that can be used as the target of form submissions.
      `frame-ancestors 'self'`, // Prevents clickjacking by restricting who can embed the page in a frame.
      `frame-src 'self'`, // Allows frames from the same origin.
      `img-src 'self' data: www.canada.ca`, // Allows images from self, data URIs, and specific external sources.
      `object-src data:`, // Allows <object>, <embed>, or <applet> from data URIs.
      `script-src 'self' 'nonce-${response.locals.nonce}'`, // Allows scripts from self and those with the generated nonce.
      // NOTE: 'unsafe-inline' might be required by some third-party libraries (like Radix Primitives).
      // It's generally recommended to avoid 'unsafe-inline' and use nonces or hashes instead.
      `style-src 'self' 'unsafe-inline' fonts.googleapis.com use.fontawesome.com www.canada.ca`, // Allows styles from self, inline styles (if necessary), and specified external sources.
    ].join('; ');

    // Define the Permissions Policy. This header allows or disallows the use of browser features.
    const permissionsPolicy = [
      'camera=()', // Disables camera access.
      'display-capture=()', // Disables display capture.
      'fullscreen=()', // Disables fullscreen mode.
      'geolocation=()', // Disables geolocation.
      'interest-cohort=()', // Disables FLoC (Federated Learning of Cohorts).
      'microphone=()', // Disables microphone access.
      'publickey-credentials-get=()', // Disables Public Key Credential access.
      'screen-wake-lock=()', // Disables screen wake lock.
    ].join(', ');

    // Set the security headers on the response.
    response.setHeader('Permissions-Policy', permissionsPolicy);
    response.setHeader('Content-Security-Policy', contentSecurityPolicy);
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); // Isolates the browsing context.
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin'); // Prevents cross-origin reading of resources.
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin'); // Controls how much referrer information is sent.
    response.setHeader('Server', 'webserver'); // Custom server header (can be generic).
    response.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains'); // Enforces HTTPS for a long duration.
    response.setHeader('X-Content-Type-Options', 'nosniff'); // Prevents browsers from MIME-sniffing a response away from the declared content-type.
    response.setHeader('X-Frame-Options', 'deny'); // Prevents clickjacking by disallowing framing of the page.
    next(); // Pass control to the next middleware.
  };
}

/**
 * Configures the session middleware using `express-session`. This middleware
 * enables session management, allowing you to store user-specific data across requests.
 * It can be configured to use different session stores (e.g., Redis for production,
 * in-memory for development) based on environment variables.
 * Certain paths (e.g., API endpoints) can be ignored to prevent unnecessary session creation.
 */
export function session(environment: ServerEnvironment): RequestHandler {
  const ignorePatterns = ['/__manifest', '/api/**']; // Paths to ignore for session management.

  const {
    isProduction,
    SESSION_TYPE,
    SESSION_COOKIE_DOMAIN,
    SESSION_COOKIE_NAME,
    SESSION_COOKIE_PATH,
    SESSION_COOKIE_SAMESITE,
    SESSION_COOKIE_SECRET,
    SESSION_COOKIE_SECURE,
  } = environment;

  // Choose the session store based on the environment configuration.
  const sessionStore =
    SESSION_TYPE === 'redis' // If Redis is configured as the session type...
      ? createRedisStore(environment) // ...create a Redis session store.
      : createMemoryStore(); // Otherwise, use an in-memory store (suitable for development).

  // Configure the express-session middleware with various options.
  const middleware = sessionMiddleware({
    store: sessionStore, // The chosen session store.
    name: SESSION_COOKIE_NAME, // The name of the session ID cookie.
    secret: [SESSION_COOKIE_SECRET.value()], // Secret(s) used to sign the session ID cookie.
    genid: () => randomUUID(), // Function to generate new session IDs.
    proxy: true, // Set to true if you're behind a reverse proxy (like Nginx).
    resave: false, // Prevents resaving sessions that haven't changed.
    rolling: true, // Resets the cookie expiration on every request.
    saveUninitialized: false, // Prevents saving new sessions that have not been modified.
    cookie: {
      domain: SESSION_COOKIE_DOMAIN, // The domain of the session cookie.
      path: SESSION_COOKIE_PATH, // The path of the session cookie.
      secure: SESSION_COOKIE_SECURE ? isProduction : false, // Only send cookie over HTTPS in production.
      httpOnly: true, // Prevents client-side JavaScript from accessing the cookie.
      sameSite: SESSION_COOKIE_SAMESITE, // Controls when cookies are sent with cross-site requests.
    },
  });

  return (request, response, next) => {
    if (shouldIgnore(ignorePatterns, request.path)) {
      // If the path should be ignored, skip session middleware.
      LogFactory.getLogger('session').trace('Skipping session: [%s]', request.path);
      return next();
    }
    // Otherwise, process the request with the session middleware.
    return middleware(request, response, next);
  };
}

/**
 * Configures the tracing middleware, which integrates with OpenTelemetry to add
 * information to the active span for each request. This is essential for distributed
 * tracing and understanding the flow of requests through your system.
 */
export function tracing(): RequestHandler {
  const ignorePatterns: string[] = [
    // Add paths to ignore tracing if necessary (e.g., for very frequent health checks).
  ];

  return (request, response, next) => {
    if (shouldIgnore(ignorePatterns, request.path)) {
      // If the path should be ignored, skip tracing.
      LogFactory.getLogger('tracing').trace('Skipping tracing: [%s]', request.path);
      return next();
    }

    // Get the currently active OpenTelemetry span.
    const span = trace.getActiveSpan();

    // Construct a more descriptive span name based on the request method and path.
    // The URL constructor is used to safely parse the request URL.
    const { pathname } = new URL(request.url, 'http://localhost:3000/');
    const spanName = `${request.method} ${pathname}`;

    // Update the span's name. This helps in visualizing and analyzing traces.
    LogFactory.getLogger('tracing').trace('Updating span name to match request: [%s]', spanName);
    span?.updateName(spanName);

    return next(); // Pass control to the next middleware.
  };
}
```

## Request and error handling

Request handling and error handling both live in `app/.server/express/handlers.ts`. This file decides how the server
processes a request and what happens when something goes wrong.

```typescript
import { createRequestHandler } from '@react-router/express';
import type { ErrorRequestHandler, NextFunction, Request, Response } from 'express';
import path from 'node:path';
import type { ViteDevServer } from 'vite';

import { serverEnvironment } from '~/.server/environment';
import { LogFactory } from '~/.server/logging';
import { HttpStatusCodes } from '~/errors/http-status-codes';

/**
 * Implements a global error handler for the Express application. This middleware
 * is designed to catch any unhandled errors that occur during the request-response
 * cycle and provide a consistent error response to the client.
 * It prioritizes sending a static HTML error page for a better user experience.
 */
export function globalErrorHandler(): ErrorRequestHandler {
  return (error: unknown, request: Request, response: Response, next: NextFunction) => {
    // Log the unexpected error for debugging purposes.
    LogFactory.getLogger('errorHandler').error('Unexpected error caught by express server', error);

    // If headers have already been sent, it's too late to send a new response
    // (like an error page). In this case, delegate to the default Express error handler.
    if (response.headersSent) {
      LogFactory.getLogger('errorHandler').error('Response headers have already been sent; skipping friendly error page');
      return next(error);
    }

    // Determine which static error page to send based on the response status code.
    // For example, if the status code is 403 (Forbidden), send 403.html; otherwise, send 500.html.
    const errorFile =
      response.statusCode === HttpStatusCodes.FORBIDDEN // Check if the status code is 403
        ? './assets/403.html' // If 403, use the 403 error page.
        : './assets/500.html'; // Otherwise, default to the 500 error page.

    // Construct the absolute path to the error HTML file.
    // `import.meta.dirname` provides the directory name of the current module.
    const errorFilePath = path.join(import.meta.dirname, errorFile);

    // Set the response status code and send the appropriate static HTML file.
    response.status(response.statusCode).sendFile(errorFilePath, (dispatchError: unknown) => {
      // If there's an error sending the error page itself (which is highly unlikely but possible),
      // log it and send a generic "Internal Server Error" message as a last resort.
      if (dispatchError) {
        LogFactory.getLogger('errorHandler').error('Unexpected error while dispatching error page... this is bad!', dispatchError);
        response.status(HttpStatusCodes.INTERNAL_SERVER_ERROR).send('Internal Server Error');
      }
    });
  };
}

/**
 * Creates and returns a request handler specifically designed for React Router v7
 * applications with Server-Side Rendering (SSR) capabilities. This handler
 * integrates with `@react-router/express` to render your React application on the server.
 *
 * @param viteDevServer An optional ViteDevServer instance, used in development for HMR and module loading.
 * @returns An Express RequestHandler that processes React Router requests.
 */
export function rrRequestHandler(viteDevServer?: ViteDevServer) {
  // The path to the server build of the React Router application.
  // This is dynamically declared to avoid static analysis issues.
  const rrServerBuild = './app.js';

  return createRequestHandler({
    mode: serverEnvironment.NODE_ENV, // Set the mode (development or production).

    // `getLoadContext` provides a way to pass server-specific data to your
    // React Router loaders and actions. This is where you can inject things
    // like session information or security nonces.
    getLoadContext: (request, response) => ({
      nonce: response.locals.nonce, // The nonce generated by the security middleware.
      session: request.session, // The session object from the session middleware.
    }),

    // The `build` function tells React Router how to load your server-side
    // application bundle. In development, it uses Vite's SSR module loading;
    // in production, it directly imports the pre-built server bundle.
    build: viteDevServer // If a Vite dev server is present...
      ? () => viteDevServer.ssrLoadModule('virtual:react-router/server-build') // ...load modules via Vite's SSR.
      : () => import(rrServerBuild), // Otherwise, import the pre-built server bundle.
  });
}
```

There are two handlers in there.

`rrRequestHandler` is the main handler for the React app. It uses `@react-router/express` to render your React components
to HTML on the server before sending the page to the browser. That can make the first page load faster and helps with SEO.

`globalErrorHandler` catches any error that nothing else in the Express app handled. Instead of letting the browser show
its own generic error, it sends back one of our static HTML pages: `403.html` for forbidden requests, or `500.html` for
internal server errors.

## Static error pages

If the framework or your own code throws an error that nobody catches, `globalErrorHandler` serves a static error page.
These are plain HTML files that act as a fallback when something unexpected breaks on the server.

They live in `app/.server/express/assets/`:

*   `403.html` is sent when the server responds with `403 Forbidden`.
*   `500.html` is sent for any other server error, usually `500 Internal Server Error`.

We like this approach for a few reasons. Users see a proper error page that looks like the rest of the app, instead of a
blank screen or a cryptic message. And because the pages are plain static HTML, the server can still send them even when
the main app code is what's failing.

Feel free to edit these files to match your branding, and add anything helpful like contact details or what the user
should try next.

## Running the server

How you run the server depends on whether you're developing locally or running in production.

### Development

During development you want the server to restart on its own whenever you change the code. We use `nodemon` for this. It
watches your source files and restarts the Node.js process when one of them changes, so you don't have to stop and start
the server by hand.

Add a script to `package.json`:

```json
"scripts": {
  "dev": "nodemon --config ./nodemon.json"
}
```

This tells `nodemon` to read its settings from `nodemon.json`. Ours looks like this:

```json
{
  "$schema": "https://json.schemastore.org/nodemon",
  "exec": "tsx --env-file-if-exists=./.env --import ./app/.server/telemetry.ts ./app/.server/express/server.ts",
  "ext": "ts",
  "watch": ["./.env", "./app/.server/express/**/*.ts"]
}
```

Here's what each setting does:

*   `exec` is the command that starts the server. We use `tsx`, which runs TypeScript files directly, and point it at the
    entry point (`./app/.server/express/server.ts`). The `--env-file-if-exists=./.env` flag loads environment variables
    from a `.env` file if there is one, and `--import ./app/.server/telemetry.ts` loads our telemetry setup first.
*   `ext` lists the file extensions to watch. Here that's just `ts`.
*   `watch` lists the files and folders to watch. A change to `.env` or to any server TypeScript file triggers a restart.

### Production

In production we run the compiled JavaScript directly with Node.js. We don't want `nodemon`'s overhead there, and we want to
run the optimized build, not the source.

After you've run the build (for example `pnpm run build`), start the server with a script like this:

```json
"scripts": {
  "start": "cross-env NODE_ENV=production node --import ./build/server/telemetry.js ./build/server/server.js"
}
```

Two things are going on in that command. `cross-env NODE_ENV=production` sets `NODE_ENV` to `production`. Many libraries
and frameworks check this variable to turn on their production behavior and optimizations, so don't skip it. Then
`node --import ./build/server/telemetry.js ./build/server/server.js` runs the compiled server entry point, using `--import`
to load the telemetry setup first.

### Preview

Preview mode sits between development and a real deployment. It runs the production build on your own machine so you can
check it before you ship it. It uses the same build output as production, but you can tweak a few settings for local
testing, like secure cookies.

Our `preview` script looks like this:

```json
"scripts": {
  "preview": "pnpm run build && cross-env NODE_ENV=production SESSION_COOKIE_SECURE=false node --env-file-if-exists=./.env --import ./build/server/telemetry.js ./build/server/server.js"
}
```

Step by step, it:

*   runs `pnpm run build`, so you're testing the latest client and server build.
*   sets `NODE_ENV` to `production` with `cross-env`, same as the `start` script.
*   sets `SESSION_COOKIE_SECURE=false`. In production, session cookies should only be sent over HTTPS (that's what "secure"
    means here). Locally you're on plain HTTP, so we turn that off.
*   runs the compiled server just like `start` does, but also passes `--env-file-if-exists=./.env` to load your local
    environment variables.

We use preview mode to catch problems that only show up in a production-like setup, like caching issues, minification
bugs or config that differs between environments, without having to deploy anything.
