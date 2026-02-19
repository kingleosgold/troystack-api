# Stack Tracker Gold API

REST API + MCP Server for Stack Tracker Gold. Provides live precious metals data, 
portfolio management, and AI/LLM integration.

## Quick Start

```bash
npm install
cp .env.example .env  # fill in Supabase credentials
npm run dev
```

## Deploy to Railway

1. Push to GitHub repo
2. Connect repo in Railway dashboard
3. Set environment variables:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `PORT` (Railway sets automatically)
4. Deploy

Custom domain: `api.stacktrackergold.com`

## Database Setup

Run `migrations/001_api_keys.sql` in Supabase SQL editor.

## Endpoints

### Public (no auth)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/prices` | Live spot prices (Au, Ag, Pt, Pd) |
| GET | `/v1/prices/history` | Historical prices |
| GET | `/v1/market-intel` | News headlines |
| GET | `/v1/vault-watch` | COMEX inventory |
| GET | `/v1/speculation` | What-if projections |

### Authenticated (Bearer token)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/portfolio` | Portfolio summary |
| GET | `/v1/analytics` | Cost basis analysis |
| GET | `/v1/holdings` | List holdings |
| POST | `/v1/holdings` | Add purchase |

### LLM / AI
| Path | Description |
|------|-------------|
| `/llms.txt` | LLM-readable description |
| `/openapi.json` | OpenAPI 3.0 spec |
| `/.well-known/ai-plugin.json` | AI plugin manifest |
| `/.well-known/mcp.json` | MCP server manifest |

## Architecture

```
User's iPhone → Stack Tracker Gold app (local SQLite)
                          ↕ sync
                    Supabase (server-side storage)
                          ↕
                    STG API (Railway)
                      ↕         ↕
                  AI Agents    X/Twitter Bot
                (Claude, GPT)  (auto-tweets)
```
