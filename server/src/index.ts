import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import trainerRouter from './routes/trainer'
import usersRouter from './routes/users'

const app = express()
const PORT = process.env.PORT || 3001

app.use(cors())
app.use(express.json())

app.use('/api/trainer', trainerRouter)
app.use('/api/users', usersRouter)

app.get('/health', (_req, res) => res.json({ status: 'ok' }))

app.listen(PORT, () => console.log(`Server running on port ${PORT}`))
