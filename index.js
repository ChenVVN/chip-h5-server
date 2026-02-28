import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import cors from 'cors'
import mongoose from 'mongoose'
import dotenv from 'dotenv'

dotenv.config()

const app = express()
const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
})

app.use(cors())
app.use(express.json())

// MongoDB 连接
const MONGODB_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/chip-platform'

mongoose.connect(MONGODB_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB connection error:', err))

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
  deskScore: { type: Number, default: 0 },
  members: [{
    odid: String,
    nickname: String,
    avatar: String,
    personalScore: { type: Number, default: 0 }
  }],
  logs: [{
    action: String, // '支出' 或 '收回' 或 '加入'
    odid: String,
    nickname: String,
    amount: Number,
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
    const { odid, nickname, avatar } = req.body
    let user = await User.findOne({ odid })
    if (user) {
      if (nickname) user.nickname = nickname
      if (avatar) user.avatar = avatar
      await user.save()
    } else {
      user = await User.create({ odid, nickname, avatar })
    }
    res.json({ success: true, data: user })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// 创建房间
app.post('/api/rooms', async (req, res) => {
  try {
    const { ownerId, ownerName, ownerAvatar } = req.body
    const roomCode = generateRoomCode()
    const room = await Room.create({
      roomCode,
      roomName: `房间${roomCode}`,
      ownerId,
      deskScore: 0,
      members: [{
        odid: ownerId,
        nickname: ownerName,
        avatar: ownerAvatar,
        personalScore: 0
      }],
      logs: [],
      expireAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    })
    res.json({ success: true, data: room })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// 获取或更新房间内成员资料
app.post('/api/rooms/:roomId/updateMember', async (req, res) => {
  try {
    const { odid, nickname, avatar } = req.body
    const room = await Room.findById(req.params.roomId)
    if (!room) {
      return res.status(404).json({ success: false, error: '房间不存在' })
    }
    const member = room.members.find(m => m.odid === odid)
    if (!member) {
      return res.status(400).json({ success: false, error: '成员不存在' })
    }
    // 更新成员信息
    if (nickname) member.nickname = nickname
    if (avatar) member.avatar = avatar
    await room.save()
    // 广播成员资料更新
    io.to(room.roomCode).emit('memberUpdate', {
      odid,
      nickname: member.nickname,
      avatar: member.avatar
    })
    res.json({ success: true, data: room })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// 加入房间
app.post('/api/rooms/join', async (req, res) => {
  try {
    const { roomCode, odid, nickname, avatar } = req.body
    const room = await Room.findOne({ roomCode })
    if (!room) {
      return res.status(404).json({ success: false, error: '房间不存在' })
    }
    if (room.members.length >= 20) {
      return res.status(400).json({ success: false, error: '房间已满' })
    }
    const existingMember = room.members.find(m => m.odid === odid)
    const isReturning = !!existingMember
    
    if (!isReturning) {
      room.members.push({ odid, nickname, avatar, personalScore: 0 })
      // 添加加入日志
      room.logs.unshift({
        action: '加入',
        odid,
        nickname,
        amount: 0,
        timestamp: new Date()
      })
    } else {
      // 更新成员信息（返回房间时同步最新信息）
      if (nickname) existingMember.nickname = nickname
      if (avatar) existingMember.avatar = avatar
      // 添加返回房间日志
      room.logs.unshift({
        action: '返回',
        odid,
        nickname: existingMember.nickname,
        amount: 0,
        timestamp: new Date()
      })
    }
    await room.save()
    // 广播新用户加入
    io.to(room.roomCode).emit('roomUpdate', room)
    res.json({ success: true, data: room })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// 获取房间信息
app.get('/api/rooms/:roomCode', async (req, res) => {
  try {
    const room = await Room.findOne({ roomCode: req.params.roomCode })
    if (!room) {
      return res.status(404).json({ success: false, error: '房间不存在' })
    }
    res.json({ success: true, data: room })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// 支出积分
app.post('/api/rooms/:roomId/spend', async (req, res) => {
  try {
    const { odid, nickname, amount } = req.body
    const room = await Room.findById(req.params.roomId)
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
    await room.save()
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
    const { odid, nickname, amount } = req.body
    const room = await Room.findById(req.params.roomId)
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
    await room.save()
    // 广播更新
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
