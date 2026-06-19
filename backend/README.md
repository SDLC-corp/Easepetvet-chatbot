# EasePetVet Chatbot — Backend

Backend foundation for the EasePetVet website RAG chatbot.

This phase provides only the server skeleton: Express app, environment config,
Pino logging, centralized error handling, a custom validation helper, and a
single health route. No database, crawler, or chatbot logic yet.

## Requirements

- Node.js >= 18

## Setup

1. Install dependencies:

   ```
   npm install
   ```

2. Create your local environment file from the example and adjust values:

   ```
   cp .env.example .env
   ```

   | Variable    | Description                                   | Default       |
   |-------------|-----------------------------------------------|---------------|
   | `PORT`      | Port the server listens on                    | `3000`        |
   | `NODE_ENV`  | `development` \| `production` \| `test`        | `development` |
   | `LOG_LEVEL` | Pino log level (`info`, `debug`, `error`, ...) | `info`        |

## Run

```
npm start
```

The server logs that it is listening and exposes:

```
GET /health  ->  200  { "status": "ok", "uptime": <seconds>, "timestamp": <iso> }
```

Check it:

```
curl http://localhost:3000/health
```

## Project structure

```
src/
  app.js                          Express app (routes + error handler), no listen()
  server.js                       Entry point, starts the HTTP server
  config/
    env.js                        Loads and validates environment variables
  routes/
    health.routes.js              GET /health
  shared/
    logger/logger.js              Single Pino logger instance
    errors/app-error.js           Operational error class
    errors/error-handler.js       Central Express error middleware
    validators/common.validator.js  Custom validation helpers
```
