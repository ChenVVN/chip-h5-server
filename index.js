import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import cors from 'cors'
import mongoose from 'mongoose'
import dotenv from 'dotenv'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

dotenv.config()

const app = express()
const httpServer = createServer(app)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const uploadsDir = path.join(__dirname, 'uploads')
const avatarUploadsDir = path.join(uploadsDir, 'avatars')
const avatarPublicPath = '/uploads/avatars'

app.set('trust proxy', true)

function parseCorsOrigins(value) {
  if (!value || value === '*') return '*'
  return value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
}

const corsOrigins = parseCorsOrigins(
  process.env.CORS_ORIGIN || 'https://cwnchip.top,https://www.cwnchip.top,http://127.0.0.1:4173,http://localhost:4173'
)

function isAllowedOrigin(origin) {
  if (corsOrigins === '*') return true
  if (!origin) return true
  return corsOrigins.includes(origin)
}

function corsOriginHandler(origin, callback) {
  if (isAllowedOrigin(origin)) {
    callback(null, true)
    return
  }

  callback(new Error(`CORS origin not allowed: ${origin}`))
}

const io = new Server(httpServer, {
  cors: {
    origin: corsOriginHandler,
    methods: ['GET', 'POST']
  }
})

app.use(cors({ origin: corsOriginHandler, credentials: false }))
app.use(express.json({ limit: '2mb' }))
app.use('/uploads', express.static(uploadsDir))

// MongoDB 连接
const MONGODB_URI = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/chip-platform'
let useMemoryStore = process.env.USE_MEMORY_STORE === '1'
let storageModeReady = Promise.resolve()

const memoryUsers = new Map()
const memoryRooms = new Map()

if (!useMemoryStore) {
  storageModeReady = mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 2000
  })
    .then(() => console.log('MongoDB connected'))
    .catch(err => {
      useMemoryStore = true
      console.error('MongoDB connection error:', err)
      console.log('Falling back to in-memory storage for local development')
    })
} else {
  console.log('Using in-memory storage')
}

async function ensureStorageMode() {
  await storageModeReady
}

function createMemoryId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

function normalizeMemoryUser(user) {
  return {
    _id: user._id || createMemoryId('user'),
    odid: user.odid,
    nickname: user.nickname || '',
    avatar: user.avatar || '',
    createdAt: user.createdAt || new Date()
  }
}

function normalizeMemoryRoom(room) {
  return {
    _id: room._id || createMemoryId('room'),
    roomCode: room.roomCode,
    roomName: room.roomName,
    ownerId: room.ownerId,
    creatorId: room.creatorId || room.ownerId,
    initialScore: room.initialScore || 0,
    distributedMembers: room.distributedMembers || [],
    deskScore: room.deskScore || 0,
    members: (room.members || []).map(member => ({
      odid: member.odid,
      nickname: member.nickname || '',
      avatar: member.avatar || '',
      personalScore: member.personalScore || 0
    })),
    logs: (room.logs || []).map(log => ({
      action: log.action,
      odid: log.odid,
      nickname: log.nickname || '',
      amount: log.amount || 0,
      memberNames: log.memberNames || [],
      timestamp: log.timestamp || new Date()
    })),
    createdAt: room.createdAt || new Date(),
    expireAt: room.expireAt || null
  }
}

function saveMemoryUser(user) {
  const normalized = normalizeMemoryUser(user)
  memoryUsers.set(normalized.odid, normalized)
  return normalized
}

function saveMemoryRoom(room) {
  const normalized = normalizeMemoryRoom(room)
  memoryRooms.set(normalized._id, normalized)
  return normalized
}

function findMemoryUserByOdid(odid) {
  return memoryUsers.get(odid) || null
}

function findMemoryRoomByCode(roomCode) {
  for (const room of memoryRooms.values()) {
    if (room.roomCode === roomCode) return room
  }
  return null
}

function findMemoryRoomById(roomId) {
  return memoryRooms.get(roomId) || null
}

async function ensureUploadDirs() {
  await fs.mkdir(avatarUploadsDir, { recursive: true })
}

function getAssetBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) {
    return process.env.PUBLIC_BASE_URL.replace(/\/$/, '')
  }
  return `${req.protocol}://${req.get('host')}`
}

function toAbsoluteAvatarUrl(req, avatarPath) {
  if (!avatarPath) return ''
  if (/^https?:\/\//i.test(avatarPath) || avatarPath.startsWith('data:image/')) {
    return avatarPath
  }
  return `${getAssetBaseUrl(req)}${avatarPath.startsWith('/') ? avatarPath : `/${avatarPath}`}`
}

function extractLocalUploadPath(avatarUrl) {
  if (!avatarUrl) return null
  try {
    const parsed = new URL(avatarUrl)
    if (parsed.pathname.startsWith(`${avatarPublicPath}/`)) {
      return path.join(uploadsDir, parsed.pathname.replace(/^\/uploads\//, ''))
    }
  } catch {
    if (avatarUrl.startsWith(`${avatarPublicPath}/`)) {
      return path.join(uploadsDir, avatarUrl.replace(/^\/uploads\//, ''))
    }
  }
  return null
}

async function removeLocalAvatarFile(avatarUrl) {
  const filePath = extractLocalUploadPath(avatarUrl)
  if (!filePath) return
  try {
    await fs.unlink(filePath)
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('Failed to remove old avatar file:', err)
    }
  }
}

async function persistAvatar(req, avatar, previousAvatar = '') {
  if (!avatar || !avatar.startsWith('data:image/')) {
    return toAbsoluteAvatarUrl(req, avatar)
  }

  const match = avatar.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/)
  if (!match) {
    throw new Error('头像格式不正确')
  }

  const [, mimeType, base64Data] = match
  const extension = mimeType.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg'
  const fileName = `${Date.now()}-${crypto.randomUUID()}.${extension}`
  const relativePath = `${avatarPublicPath}/${fileName}`
  const absolutePath = path.join(avatarUploadsDir, fileName)

  await ensureUploadDirs()
  await fs.writeFile(absolutePath, Buffer.from(base64Data, 'base64'))

  if (previousAvatar && previousAvatar !== avatar) {
    await removeLocalAvatarFile(previousAvatar)
  }

  return toAbsoluteAvatarUrl(req, relativePath)
}

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    data: {
      status: 'ok',
      time: new Date().toISOString(),
      storage: useMemoryStore ? 'memory' : 'mongodb'
    }
  })
})

// 数据模型
const UserSchema = new mongoose.Schema({
  odid: String,
  nickname: String,
  avatar: String,
  createdAt: { type: Date, default: Date.now }
})

const RoomSchema = new mongoose.Schema({
  roomCode: String,
  roomName: String,
  ownerId: String,
  creatorId: String,
  initialScore: { type: Number, default: 0 },
  distributedMembers: [String],
  deskScore: { type: Number, default: 0 },
  members: [{
    odid: String,
    nickname: String,
    avatar: String,
    personalScore: { type: Number, default: 0 }
  }],
  logs: [{
    action: String,
    odid: String,
    nickname: String,
    amount: Number,
    memberNames: [String],
    timestamp: { type: Date, default: Date.now }
  }],
  createdAt: { type: Date, default: Date.now },
  expireAt: Date
})

const User = mongoose.model('User', UserSchema)
const Room = mongoose.model('Room', RoomSchema)

// 生成6位房间号
function generateRoomCode() {
  return Math.floor(100000 + Math.random() * 900000).toString()
}

// API 路由
// 获取或创建用户
app.post('/api/user', async (req, res) => {
  try {
    await ensureStorageMode()
    const { odid, nickname, avatar } = req.body
    if (useMemoryStore) {
      const existingUser = findMemoryUserByOdid(odid)
      const savedAvatar = avatar !== undefined
        ? await persistAvatar(req, avatar, existingUser?.avatar || '')
        : (existingUser?.avatar || '')
      const user = saveMemoryUser({
        ...(existingUser || {}),
        odid,
        nickname: nickname ?? existingUser?.nickname ?? '',
        avatar: savedAvatar
      })
      return res.json({ success: true, data: user })
    }

    let user = await User.findOne({ odid })
    if (user) {
      if (nickname !== undefined) user.nickname = nickname
      if (avatar !== undefined) user.avatar = await persistAvatar(req, avatar, user.avatar || '')
      await user.save()
    } else {
      user = await User.create({
        odid,
        nickname,
        avatar: await persistAvatar(req, avatar)
      })
    }
    res.json({ success: true, data: user })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// 创建房间
app.post('/api/rooms', async (req, res) => {
  try {
    await ensureStorageMode()
    const { ownerId, ownerName, ownerAvatar } = req.body
    const roomCode = generateRoomCode()
    const roomPayload = {
      roomCode,
      roomName: `房间${roomCode}`,
      ownerId,
      creatorId: ownerId,
      initialScore: 0,
      deskScore: 0,
      members: [{
        odid: ownerId,
        nickname: ownerName,
        avatar: ownerAvatar,
        personalScore: 0
      }],
      logs: [],
      expireAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    }

    const room = useMemoryStore
      ? saveMemoryRoom(roomPayload)
      : await Room.create(roomPayload)

    res.json({ success: true, data: room })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// 加入房间
app.post('/api/rooms/join', async (req, res) => {
  try {
    await ensureStorageMode()
    const { roomCode, odid, nickname, avatar } = req.body
    const room = useMemoryStore
      ? findMemoryRoomByCode(roomCode)
      : await Room.findOne({ roomCode })
    if (!room) {
      return res.status(404).json({ success: false, error: '房间不存在' })
    }
    if (room.members.length >= 20) {
      return res.status(400).json({ success: false, error: '房间已满' })
    }
    const isInRoom = room.members.some(m => m.odid === odid)
    if (!isInRoom) {
      room.members.push({ odid, nickname, avatar, personalScore: 0 })
      // 添加加入日志
      room.logs.unshift({
        action: '加入',
        odid,
        nickname,
        amount: 0,
        timestamp: new Date()
      })
      if (useMemoryStore) {
        saveMemoryRoom(room)
      } else {
        await room.save()
      }
      // 广播新用户加入
      io.to(room.roomCode).emit('roomUpdate', room)
    }
    res.json({ success: true, data: room })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// 重新加入房间（返回房间）
app.post('/api/rooms/rejoin', async (req, res) => {
  try {
    await ensureStorageMode()
    const { roomCode, odid, nickname, avatar } = req.body
    const room = useMemoryStore
      ? findMemoryRoomByCode(roomCode)
      : await Room.findOne({ roomCode })
    if (!room) {
      return res.status(404).json({ success: false, error: '房间不存在' })
    }
    const isInRoom = room.members.some(m => m.odid === odid)
    if (!isInRoom) {
      let lastScore = 0
      for (const log of room.logs) {
        if (log.odid === odid && log.action === '离开') {
          lastScore = log.amount || 0
          break
        }
      }

      room.members.push({ odid, nickname, avatar, personalScore: lastScore })
      room.logs.unshift({
        action: '返回',
        odid,
        nickname,
        amount: 0,
        timestamp: new Date()
      })
      if (useMemoryStore) {
        saveMemoryRoom(room)
      } else {
        await room.save()
      }
      io.to(room.roomCode).emit('roomUpdate', room)
    }
    res.json({ success: true, data: room })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// 获取房间信息
app.get('/api/rooms/:roomCode', async (req, res) => {
  try {
    await ensureStorageMode()
    const room = useMemoryStore
      ? findMemoryRoomByCode(req.params.roomCode)
      : await Room.findOne({ roomCode: req.params.roomCode })
    if (!room) {
      return res.status(404).json({ success: false, error: '房间不存在' })
    }
    res.json({ success: true, data: room })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// 更新房间内成员信息
app.post('/api/rooms/:roomId/updateMember', async (req, res) => {
  try {
    await ensureStorageMode()
    const { odid, nickname, avatar } = req.body
    const room = useMemoryStore
      ? findMemoryRoomById(req.params.roomId)
      : await Room.findById(req.params.roomId)
    if (!room) {
      return res.status(404).json({ success: false, error: '房间不存在' })
    }
    const member = room.members.find(m => m.odid === odid)
    if (!member) {
      return res.status(400).json({ success: false, error: '成员不存在' })
    }
    if (nickname !== undefined) member.nickname = nickname
    if (avatar !== undefined) member.avatar = await persistAvatar(req, avatar, member.avatar || '')
    if (useMemoryStore) {
      saveMemoryRoom(room)
    } else {
      await room.save()
    }
    io.to(room.roomCode).emit('roomUpdate', room)
    res.json({ success: true, data: room })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// 离开房间
app.post('/api/rooms/:roomId/leave', async (req, res) => {
  try {
    await ensureStorageMode()
    const { odid, nickname } = req.body
    const room = useMemoryStore
      ? findMemoryRoomById(req.params.roomId)
      : await Room.findById(req.params.roomId)
    if (!room) {
      return res.status(404).json({ success: false, error: '房间不存在' })
    }
    const idx = room.members.findIndex(m => m.odid === odid)
    if (idx === -1) {
      return res.status(400).json({ success: false, error: '成员不存在' })
    }
    const leaveScore = room.members[idx].personalScore
    room.logs.unshift({
      action: '离开',
      odid,
      nickname,
      amount: leaveScore,
      timestamp: new Date()
    })
    room.members.splice(idx, 1)
    if (useMemoryStore) {
      saveMemoryRoom(room)
    } else {
      await room.save()
    }
    io.to(room.roomCode).emit('roomUpdate', room)
    res.json({ success: true, data: room })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// 支出积分
app.post('/api/rooms/:roomId/spend', async (req, res) => {
  try {
    await ensureStorageMode()
    const { odid, nickname, amount } = req.body
    const room = useMemoryStore
      ? findMemoryRoomById(req.params.roomId)
      : await Room.findById(req.params.roomId)
    if (!room) {
      return res.status(404).json({ success: false, error: '房间不存在' })
    }
    const member = room.members.find(m => m.odid === odid)
    if (!member) {
      return res.status(400).json({ success: false, error: '成员不存在' })
    }
    // 支出积分不做限制，个人积分可以为负
    member.personalScore -= amount
    room.deskScore += amount
    room.logs.unshift({
      action: '支出',
      odid,
      nickname,
      amount,
      timestamp: new Date()
    })
    if (useMemoryStore) {
      saveMemoryRoom(room)
    } else {
      await room.save()
    }
    // 广播更新
    io.to(room.roomCode).emit('roomUpdate', room)
    res.json({ success: true, data: room })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// 收回积分
app.post('/api/rooms/:roomId/reclaim', async (req, res) => {
  try {
    await ensureStorageMode()
    const { odid, nickname, amount } = req.body
    const room = useMemoryStore
      ? findMemoryRoomById(req.params.roomId)
      : await Room.findById(req.params.roomId)
    if (!room) {
      return res.status(404).json({ success: false, error: '房间不存在' })
    }
    if (room.deskScore < amount) {
      return res.status(400).json({ success: false, error: '桌面积分不足' })
    }
    const member = room.members.find(m => m.odid === odid)
    if (!member) {
      return res.status(400).json({ success: false, error: '不在房间中' })
    }
    member.personalScore += amount
    room.deskScore -= amount
    room.logs.unshift({
      action: '收回',
      odid,
      nickname,
      amount,
      timestamp: new Date()
    })
    if (useMemoryStore) {
      saveMemoryRoom(room)
    } else {
      await room.save()
    }
    // 广播更新
    io.to(room.roomCode).emit('roomUpdate', room)
    res.json({ success: true, data: room })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// 分配初始积分
app.post('/api/rooms/:roomId/distribute', async (req, res) => {
  try {
    await ensureStorageMode()
    const { operatorId, amount } = req.body
    const room = useMemoryStore
      ? findMemoryRoomById(req.params.roomId)
      : await Room.findById(req.params.roomId)
    if (!room) {
      return res.status(404).json({ success: false, error: '房间不存在' })
    }
    if (room.creatorId !== operatorId) {
      return res.status(403).json({ success: false, error: '仅群主可分配筹码' })
    }

    const distributeAmount = Number(amount) || 0
    if (distributeAmount <= 0) {
      return res.status(400).json({ success: false, error: '请输入有效的积分数额' })
    }

    // 筛选尚未领取初始积分的成员
    const distributedSet = new Set(room.distributedMembers || [])
    const newMembers = room.members.filter(m => !distributedSet.has(m.odid))

    if (newMembers.length === 0) {
      return res.status(400).json({ success: false, error: '所有成员已领取过初始积分' })
    }

    room.initialScore = distributeAmount

    // 给未领取的成员发放初始积分
    const distributedNames = []
    for (const member of newMembers) {
      member.personalScore = (member.personalScore || 0) + distributeAmount
      distributedSet.add(member.odid)
      distributedNames.push(member.nickname || '未命名')
    }
    room.distributedMembers = Array.from(distributedSet)

    // 添加发放日志（记录成员名单）
    room.logs.unshift({
      action: '系统发放',
      odid: '',
      nickname: '系统',
      amount: distributeAmount,
      memberNames: distributedNames,
      timestamp: new Date()
    })

    if (useMemoryStore) {
      saveMemoryRoom(room)
    } else {
      await room.save()
    }
    io.to(room.roomCode).emit('roomUpdate', room)
    res.json({ success: true, data: room })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// WebSocket 处理
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id)

  // 加入房间
  socket.on('joinRoom', (roomCode) => {
    socket.join(roomCode)
    console.log(`Socket ${socket.id} joined room ${roomCode}`)
  })

  // 离开房间
  socket.on('leaveRoom', (roomCode) => {
    socket.leave(roomCode)
  })

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id)
  })
})

const PORT = process.env.PORT || 3000
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})
