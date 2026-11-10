import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import trainerRouter from './routes/trainer'
import usersRouter from './routes/users'
import sessionsRouter from './routes/sessions'
import { resumeGrading } from './lib/session/grader'

const app = express()
const PORT = process.env.PORT || 3001

app.use(cors())
app.use(express.json({ limit: '20mb' }))   // hand-history files can be a few MB

app.use('/api/trainer', trainerRouter)
app.use('/api/users', usersRouter)
app.use('/api/sessions', sessionsRouter)

app.get('/health', (_req, res) => res.json({ status: 'ok' }))

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
  resumeGrading().catch(err => console.error('Could not resume session grading:', err))
})
