# File Processor Service
# Cloud Run service for document processing with LibreOffice + OpenAI Vision
#
# Features:
# - LibreOffice for Office document to PDF conversion
# - Poppler for PDF to image conversion
# - Sharp for image processing and thumbnails
# - OpenAI Vision API for text extraction

FROM node:20-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    # LibreOffice for Office document conversion
    libreoffice \
    libreoffice-writer \
    libreoffice-calc \
    libreoffice-impress \
    # Poppler for PDF processing
    poppler-utils \
    # Fonts for proper document rendering
    fonts-liberation \
    fonts-dejavu-core \
    fonts-freefont-ttf \
    # Image processing dependencies for Sharp
    libvips-dev \
    # Clean up
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node.js dependencies
RUN npm ci --only=production

# Copy application code
COPY . .

# Create temp directory for file processing
RUN mkdir -p /tmp/file-processor

# Set environment variables
ENV NODE_ENV=production
ENV TEMP_DIR=/tmp/file-processor

# Cloud Run uses PORT environment variable
ENV PORT=8080
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

# Run the service
CMD ["node", "server.js"]
