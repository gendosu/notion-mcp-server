import { Tool } from '@modelcontextprotocol/sdk/types.js'
import { JSONSchema7 as IJsonSchema } from 'json-schema'
import { HttpClient, HttpClientError } from '../client/http-client'
import path from 'path'
import fs from 'fs'

/**
 * Specialized MCP tools for Notion file upload functionality
 * These tools provide high-level interfaces for the 3-stage file upload process
 */

export const NOTION_FILE_UPLOAD_TOOLS: Tool[] = [
  {
    name: 'notion_upload_file',
    description: 'Upload a file to Notion using the 3-stage upload process. Handles create, send, and complete operations automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          format: 'uri-reference',
          description: 'Absolute path to the local file to upload. File must exist and be readable.'
        },
        validate_file: {
          type: 'boolean',
          default: true,
          description: 'Whether to validate file size (5MB limit) and type (supported formats only). Defaults to true.'
        }
      },
      required: ['file_path'],
      additionalProperties: false
    }
  },
  {
    name: 'notion_get_file_info',
    description: 'Get information about a local file for Notion upload compatibility check.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          format: 'uri-reference',
          description: 'Absolute path to the local file to analyze.'
        }
      },
      required: ['file_path'],
      additionalProperties: false
    }
  },
  {
    name: 'notion_validate_file',
    description: 'Validate if a file meets Notion upload requirements (size, format, filename length).',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          format: 'uri-reference',
          description: 'Absolute path to the local file to validate.'
        },
        max_size_mb: {
          type: 'number',
          default: 5,
          minimum: 0.1,
          maximum: 5120,
          description: 'Maximum file size in MB. Default is 5MB for free workspaces.'
        }
      },
      required: ['file_path'],
      additionalProperties: false
    }
  }
]

/**
 * Handler class for Notion file upload MCP tools
 */
export class NotionFileUploadHandler {
  constructor(private httpClient: HttpClient) {}

  /**
   * Handles the complete file upload process
   */
  async handleFileUpload(params: {
    file_path: string
    validate_file?: boolean
  }): Promise<{
    success: boolean
    file_id?: string
    file_url?: string
    error?: string
    validation_errors?: string[]
  }> {
    try {
      const { file_path, validate_file = true } = params

      // Validate file path exists
      if (!fs.existsSync(file_path)) {
        return {
          success: false,
          error: `File not found: ${file_path}`
        }
      }

      // Get file information
      const fileInfo = this.httpClient.getFileInfo(file_path)

      // Validate file if requested
      if (validate_file) {
        try {
          // This will throw if validation fails
          this.httpClient.getFileInfo(file_path)
        } catch (error) {
          if (error instanceof HttpClientError) {
            return {
              success: false,
              error: error.message,
              validation_errors: [error.message]
            }
          }
          throw error
        }
      }

      // Step 1: Create file upload
      const createResponse = await this.httpClient.executeOperation(
        {
          operationId: 'create-file-upload',
          method: 'post',
          path: '/v1/file_uploads',
          summary: 'Create a file upload',
          responses: {}
        } as any,
        {
          file_name: fileInfo.fileName,
          file_size: fileInfo.fileSize
        }
      )

      if (createResponse.status !== 200) {
        return {
          success: false,
          error: `Failed to create file upload: ${createResponse.status}`
        }
      }

      const uploadData = createResponse.data
      const uploadId = uploadData.id

      // Step 2: Send file content
      const sendResponse = await this.httpClient.executeOperation(
        {
          operationId: 'send-file-content',
          method: 'post',
          path: `/v1/file_uploads/${uploadId}/send`,
          summary: 'Send file content',
          responses: {}
        } as any,
        {
          file: file_path
        }
      )

      if (sendResponse.status !== 200) {
        return {
          success: false,
          error: `Failed to send file content: ${sendResponse.status}`
        }
      }

      // Step 3: Complete file upload
      const completeResponse = await this.httpClient.executeOperation(
        {
          operationId: 'complete-file-upload',
          method: 'post',
          path: `/v1/file_uploads/${uploadId}/complete`,
          summary: 'Complete file upload',
          responses: {}
        } as any,
        {}
      )

      if (completeResponse.status !== 200) {
        return {
          success: false,
          error: `Failed to complete file upload: ${completeResponse.status}`
        }
      }

      const completedData = completeResponse.data
      
      return {
        success: true,
        file_id: completedData.file_upload?.id || uploadId,
        file_url: completedData.file_upload?.url,
        ...fileInfo
      }

    } catch (error) {
      if (error instanceof HttpClientError) {
        return {
          success: false,
          error: error.message
        }
      }
      
      return {
        success: false,
        error: `Unexpected error: ${(error as Error).message || error}`
      }
    }
  }

  /**
   * Get file information for compatibility checking
   */
  async handleGetFileInfo(params: {
    file_path: string
  }): Promise<{
    success: boolean
    fileName?: string
    fileSize?: number
    fileSizeMB?: number
    mimeType?: string
    extension?: string
    isSupported?: boolean
    error?: string
  }> {
    try {
      const { file_path } = params

      if (!fs.existsSync(file_path)) {
        return {
          success: false,
          error: `File not found: ${file_path}`
        }
      }

      const fileInfo = this.httpClient.getFileInfo(file_path)
      const extension = path.extname(file_path).toLowerCase()
      
      // Check if file type is supported by checking against known extensions
      const supportedExtensions = [
        '.gif', '.jpg', '.jpeg', '.png', '.svg', '.webp', // Images
        '.aac', '.mp3', '.wav', // Audio
        '.mp4', '.mov', '.webm', // Video
        '.pdf', '.docx', '.xlsx', '.pptx' // Documents
      ]
      
      const isSupported = supportedExtensions.includes(extension)

      return {
        success: true,
        fileName: fileInfo.fileName,
        fileSize: fileInfo.fileSize,
        fileSizeMB: Number((fileInfo.fileSize / 1024 / 1024).toFixed(2)),
        mimeType: fileInfo.mimeType,
        extension,
        isSupported
      }

    } catch (error) {
      if (error instanceof HttpClientError) {
        return {
          success: false,
          error: error.message
        }
      }
      
      return {
        success: false,
        error: `Unexpected error: ${(error as Error).message || error}`
      }
    }
  }

  /**
   * Validate file against Notion requirements
   */
  async handleValidateFile(params: {
    file_path: string
    max_size_mb?: number
  }): Promise<{
    success: boolean
    valid?: boolean
    errors?: string[]
    warnings?: string[]
    fileInfo?: any
    error?: string
  }> {
    try {
      const { file_path, max_size_mb = 5 } = params

      if (!fs.existsSync(file_path)) {
        return {
          success: false,
          error: `File not found: ${file_path}`
        }
      }

      const errors: string[] = []
      const warnings: string[] = []
      
      // Get basic file info first
      const fileInfo = await this.handleGetFileInfo({ file_path })
      if (!fileInfo.success) {
        return {
          success: false,
          error: fileInfo.error
        }
      }

      // Validate file size
      const maxSizeBytes = max_size_mb * 1024 * 1024
      if (fileInfo.fileSize! > maxSizeBytes) {
        errors.push(`File size ${fileInfo.fileSizeMB}MB exceeds maximum allowed size of ${max_size_mb}MB`)
      }

      // Validate file type
      if (!fileInfo.isSupported) {
        errors.push(`Unsupported file type: ${fileInfo.extension}. Supported types: .gif, .jpg, .jpeg, .png, .svg, .webp, .aac, .mp3, .wav, .mp4, .mov, .webm, .pdf, .docx, .xlsx, .pptx`)
      }

      // Validate filename length (Notion limit: 900 bytes)
      if (Buffer.byteLength(fileInfo.fileName!, 'utf8') > 900) {
        errors.push(`Filename exceeds maximum length of 900 bytes: ${fileInfo.fileName}`)
      }

      // Add warnings for edge cases
      if (fileInfo.fileSizeMB! > 20) {
        warnings.push('Files larger than 20MB require multipart upload (paid workspaces only)')
      }

      if (fileInfo.fileSizeMB! > 4.5) {
        warnings.push('File approaching 5MB limit - consider compressing if upload fails')
      }

      return {
        success: true,
        valid: errors.length === 0,
        errors: errors.length > 0 ? errors : undefined,
        warnings: warnings.length > 0 ? warnings : undefined,
        fileInfo
      }

    } catch (error) {
      return {
        success: false,
        error: `Validation error: ${(error as Error).message || error}`
      }
    }
  }
}