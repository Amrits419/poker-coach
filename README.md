# AI Poker Coach

Log poker hands, get GPT-4o analysis on your decisions, and track your leaks over time.

## Stack
- **Frontend**: React + TypeScript + Vite + Tailwind CSS
- **Backend**: Node.js + Express + TypeScript
- **Database**: PostgreSQL via Prisma
- **AI**: OpenAI GPT-4o

## Setup

### 1. Database
Create a Postgres database called `pokercoach` and update `server/.env`:
```
DATABASE_URL="postgresql://postgres:password@localhost:5432/pokercoach"
OPENAI_API_KEY="sk-..."
PORT=3001
```

### 2. Run migrations
```bash
cd server
npx prisma migrate dev --name init
```

### 3. Start the server
```bash
cd server
npm run dev
```

### 4. Start the frontend
```bash
cd client
npm run dev
```

App will be at `http://localhost:5173`

## Deployment
- Frontend → Vercel
- Backend + DB → Railway
