# Large File Chunk Uploader System

A production-ready file upload system designed to handle large files (>1GB) with advanced features like chunking, resumability, retry logic, and crash recovery.

## Tech Stack

- **Frontend**: React.js with Vite
- **Backend**: Node.js with Express
- **Database**: MongoDB 7.0
- **File Processing**: Node.js Streams
- **ZIP Handling**: yauzl
- **Hashing**: SHA-256
- **Containerization**: Docker & Docker Compose

## Features

### Frontend Capabilities
- Large file selection and chunking (5MB chunks)
- Concurrent upload control (max 3 simultaneous uploads)
- Smart retry mechanism with exponential backoff
- Real-time progress visualization
- Upload/download speed tracking
- ETA calculation
- Chunk status monitoring
- Resume support after page refresh
- Simulated 30% network failure for testing

### Backend Capabilities
- Streaming-based chunk receiving (no full file in memory)
- Out-of-order chunk assembly
- Idempotent chunk handling
- Atomic finalization with race condition protection
- SHA-256 file integrity verification
- ZIP content preview without extraction
- Automatic cleanup of orphaned uploads
- Crash recovery support

### Database
- Upload tracking with status management
- Individual chunk status monitoring
- Document-based storage with MongoDB
- Optimized indexes for performance

## Architecture

### Upload Flow

1. **Initialization**: Client sends file metadata to `/api/upload/init`
   - Server creates upload record in database
   - Returns upload ID and list of already uploaded chunks
   - Client resumes from where it left off

2. **Chunking**: File is split into 5MB chunks
   - Each chunk gets an index (0, 1, 2, ...)
   - Chunks are queued for upload

3. **Concurrent Upload**: Max 3 chunks upload simultaneously
   - Queue management ensures controlled concurrency
   - Network failures trigger exponential backoff retry

4. **Chunk Assembly**: Backend writes chunks at correct byte offsets
   - Uses `fs.open` with position-based writes
   - Supports out-of-order chunk arrival
   - Idempotent handling prevents corruption

5. **Finalization**: When all chunks received
   - Atomic status update prevents double-finalization
   - SHA-256 hash calculated for integrity
   - ZIP contents listed without extraction

### File Integrity

The system ensures file integrity through:

- **SHA-256 Hashing**: Final assembled file is hashed and stored in database
- **Chunk Tracking**: Each chunk's receipt is recorded in the database
- **Idempotency**: Duplicate chunks are safely handled without corruption
- **Offset-based Writing**: Each chunk is written to its exact position using file offsets

### Pause/Resume Mechanism

The upload can be paused and resumed through:

1. **Database State Persistence**: All chunk statuses are stored in MySQL
2. **Handshake Protocol**: Before uploading, client queries server for already-uploaded chunks
3. **Skip Completed Chunks**: Client only uploads missing chunks
4. **Page Refresh Recovery**: Frontend can recover state by querying backend
5. **Server Crash Recovery**: Database contains complete upload state for recovery

### Crash Recovery

The system handles crashes gracefully:

- **Database as Source of Truth**: All upload state persists in MySQL
- **Uploaded Chunks Preserved**: Files written to disk aren't lost
- **Resume After Restart**: Client queries server state and continues
- **Partial Upload Cleanup**: Scheduled job removes incomplete uploads after 24 hours

## Setup Instructions

### Using Docker (Recommended)

1. Clone or extract the project
2. Navigate to the project directory
3. Start all services:

```bash
docker-compose up -d
```

4. Access the application:
   - Frontend: http://localhost:5173
   - Backend API: http://localhost:3001

### Manual Setup

#### Backend

```bash
cd backend
npm install
```

Create `.env` file:
```
MONGO_URI=mongodb+srv://your_user:your_password@cluster0.xxxxx.mongodb.net/file_uploader?retryWrites=true&w=majority&appName=Cluster0
PORT=3001
```

Note: The system is configured to use MongoDB Atlas cloud database. Update the MONGO_URI with your Atlas connection string.

Run the server:
```bash
npm start
```

#### Frontend

```bash
cd frontend
npm install
npm run dev
```

## API Endpoints

### POST /api/upload/init
Initialize a new upload or resume existing one.

**Request:**
```json
{
  "uploadId": "file.zip-1234567-1234567890",
  "filename": "file.zip",
  "fileSize": 1073741824
}
```

**Response:**
```json
{
  "uploadId": "file.zip-1234567-1234567890",
  "uploadedChunks": [0, 1, 5],
  "status": "UPLOADING"
}
```

### POST /api/upload/chunk
Upload a single chunk.

**Request (multipart/form-data):**
- `chunk`: Binary chunk data
- `uploadId`: Upload identifier
- `chunkIndex`: Chunk position (0-based)
- `totalChunks`: Total number of chunks

**Response:**
```json
{
  "success": true,
  "isComplete": false,
  "receivedChunks": 42,
  "totalChunks": 200
}
```

### GET /api/upload/:uploadId/status
Get upload status and chunk information.

**Response:**
```json
{
  "upload": {
    "id": "file.zip-1234567-1234567890",
    "filename": "file.zip",
    "total_size": 1073741824,
    "total_chunks": 200,
    "status": "COMPLETED",
    "final_hash": "abc123..."
  },
  "chunks": [
    {"chunk_index": 0, "status": "RECEIVED"},
    {"chunk_index": 1, "status": "RECEIVED"}
  ]
}
```

## Database Schema

### uploads collection
```javascript
{
  id: String (unique index),
  filename: String,
  total_size: Number,
  total_chunks: Number,
  status: String, // 'UPLOADING', 'PROCESSING', 'COMPLETED', 'FAILED'
  final_hash: String,
  created_at: Date,
  updated_at: Date
}
```

### chunks collection
```javascript
{
  upload_id: String (compound index with chunk_index),
  chunk_index: Number,
  status: String, // 'PENDING', 'RECEIVED'
  received_at: Date
}
```

## Key Design Decisions & Trade-offs

### Memory Management
- **Decision**: Use streaming for chunk uploads instead of loading in memory
- **Trade-off**: Slightly more complex code, but handles unlimited file sizes
- **Benefit**: Server can handle multiple large uploads without OOM errors

### Concurrency Model
- **Decision**: Limit to 3 concurrent chunk uploads
- **Trade-off**: Could be faster with more, but risks overwhelming server/network
- **Benefit**: Balanced throughput with stability

### Chunk Size (5MB)
- **Decision**: Fixed 5MB chunks
- **Trade-off**: Smaller chunks = more overhead, larger chunks = less granular retry
- **Benefit**: Good balance for network reliability and progress tracking

### Idempotency Approach
- **Decision**: Check database before writing each chunk
- **Trade-off**: Extra database query per chunk
- **Benefit**: Prevents file corruption from retries

### Database Choice (MongoDB)
- **Decision**: Use MongoDB for flexible document storage
- **Trade-off**: Eventual consistency model vs ACID transactions
- **Benefit**: Survives server restarts, flexible schema, easy to scale

### Finalization Race Condition Handling
- **Decision**: Check upload status before finalization
- **Trade-off**: Multiple final chunks may check simultaneously
- **Benefit**: Prevents duplicate finalization processing

## Testing Scenarios

The system handles these challenging scenarios:

1. **Network Flapping**: 30% simulated failure rate with automatic retry
2. **Out-of-Order Chunks**: Chunk 99 can arrive before chunk 1
3. **Page Refresh**: Upload continues after browser refresh
4. **Server Restart**: Upload resumes after backend crash
5. **Double Finalization**: Last chunks arriving simultaneously handled safely
6. **Partial Uploads**: Cleanup job removes abandoned uploads

## Future Improvements

1. **Performance**
   - Implement Redis caching for chunk status
   - Use WebSockets for real-time progress updates
   - Add CDN support for distributed uploads
   - Parallel chunk assembly for faster finalization

2. **Features**
   - Support for multiple simultaneous file uploads
   - Compression before upload
   - Client-side encryption
   - Thumbnail generation for ZIP contents
   - Download with resume support

3. **Reliability**
   - Configurable retry strategies
   - Circuit breaker for failing backends
   - Health check endpoints
   - Metrics and monitoring integration

4. **Security**
   - File type validation
   - Virus scanning integration
   - Rate limiting per IP
   - Authentication and authorization
   - Signed upload URLs

5. **Scalability**
   - Horizontal backend scaling
   - Database read replicas
   - S3/blob storage integration
   - Message queue for finalization

## Monitoring & Maintenance

### Cleanup Schedule
The system automatically cleans up:
- Incomplete uploads older than 24 hours
- Temporary files older than 1 hour

### Logs
Check logs for:
- Upload completion with hash verification
- ZIP content listing
- Finalization errors
- Cleanup operations

### Health Checks
Monitor:
- Database connectivity
- Disk space in upload directory
- Active upload count
- Failed upload rate

## Troubleshooting

### Upload Fails to Initialize
- Check MySQL connection
- Verify database exists and tables are created
- Check backend logs for errors

### Chunks Not Uploading
- Verify CORS settings
- Check network connectivity
- Review browser console for errors
- Ensure upload directory is writable

### High Memory Usage
- Verify streaming is working (not loading full chunks in memory)
- Check for memory leaks in long-running uploads
- Monitor temp file cleanup

### Database Growing Large
- Run cleanup job more frequently
- Implement archival for old completed uploads
- Add database retention policy

