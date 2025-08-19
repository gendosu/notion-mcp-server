import type { OpenAPIV3, OpenAPIV3_1 } from 'openapi-types'
import OpenAPIClientAxios from 'openapi-client-axios'
import type { AxiosInstance } from 'axios'
import FormData from 'form-data'
import fs from 'fs'
import path from 'path'
import { Headers } from './polyfill-headers'
import { isFileUploadParameter } from '../openapi/file-upload'

export type HttpClientConfig = {
  baseUrl: string
  headers?: Record<string, string>
}

export type HttpClientResponse<T = any> = {
  data: T
  status: number
  headers: Headers
}

export type FileUploadOptions = {
  filePath: string
  validateSize?: boolean
  validateType?: boolean
  maxSizeBytes?: number
}

// Notion supported file types based on API documentation
const SUPPORTED_MIME_TYPES = {
  // Images
  'image/gif': ['.gif'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/svg+xml': ['.svg'],
  'image/webp': ['.webp'],
  // Audio
  'audio/aac': ['.aac'],
  'audio/mpeg': ['.mp3'],
  'audio/wav': ['.wav'],
  // Video
  'video/mp4': ['.mp4'],
  'video/quicktime': ['.mov'],
  'video/webm': ['.webm'],
  // Documents
  'application/pdf': ['.pdf'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['.pptx']
}

const DEFAULT_MAX_FILE_SIZE = 5 * 1024 * 1024 // 5MB in bytes

export class HttpClientError extends Error {
  constructor(
    message: string,
    public status: number,
    public data: any,
    public headers?: Headers,
  ) {
    super(`${status} ${message}`)
    this.name = 'HttpClientError'
  }
}

export class HttpClient {
  private api: Promise<AxiosInstance>
  private client: OpenAPIClientAxios

  constructor(config: HttpClientConfig, openApiSpec: OpenAPIV3.Document | OpenAPIV3_1.Document) {
    // @ts-expect-error
    this.client = new (OpenAPIClientAxios.default ?? OpenAPIClientAxios)({
      definition: openApiSpec,
      axiosConfigDefaults: {
        baseURL: config.baseUrl,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'notion-mcp-server',
          ...config.headers,
        },
      },
    })
    this.api = this.client.init()
  }

  /**
   * Validates a file for upload to Notion API
   */
  private validateFile(filePath: string, options: Partial<FileUploadOptions> = {}): void {
    const {
      validateSize = true,
      validateType = true,
      maxSizeBytes = DEFAULT_MAX_FILE_SIZE
    } = options

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      throw new HttpClientError(`File not found: ${filePath}`, 400, null)
    }

    // Get file stats
    const stats = fs.statSync(filePath)
    
    // Validate file size
    if (validateSize && stats.size > maxSizeBytes) {
      const sizeMB = (stats.size / 1024 / 1024).toFixed(2)
      const maxSizeMB = (maxSizeBytes / 1024 / 1024).toFixed(2)
      throw new HttpClientError(
        `File size ${sizeMB}MB exceeds maximum allowed size of ${maxSizeMB}MB`,
        400,
        { fileSize: stats.size, maxSize: maxSizeBytes }
      )
    }

    // Validate file type by extension
    if (validateType) {
      const fileExtension = path.extname(filePath).toLowerCase()
      const isSupported = Object.values(SUPPORTED_MIME_TYPES).some(extensions =>
        extensions.includes(fileExtension)
      )
      
      if (!isSupported) {
        const supportedExtensions = Object.values(SUPPORTED_MIME_TYPES).flat()
        throw new HttpClientError(
          `Unsupported file type: ${fileExtension}. Supported types: ${supportedExtensions.join(', ')}`,
          400,
          { extension: fileExtension, supportedExtensions }
        )
      }
    }

    // Validate filename length (Notion limit: 900 bytes)
    const fileName = path.basename(filePath)
    if (Buffer.byteLength(fileName, 'utf8') > 900) {
      throw new HttpClientError(
        `Filename exceeds maximum length of 900 bytes: ${fileName}`,
        400,
        { fileName, byteLength: Buffer.byteLength(fileName, 'utf8') }
      )
    }
  }

  /**
   * Gets MIME type for a file based on its extension
   */
  private getMimeType(filePath: string): string {
    const extension = path.extname(filePath).toLowerCase()
    
    for (const [mimeType, extensions] of Object.entries(SUPPORTED_MIME_TYPES)) {
      if (extensions.includes(extension)) {
        return mimeType
      }
    }
    
    return 'application/octet-stream' // fallback
  }

  /**
   * Creates a FormData object for file uploads with enhanced validation
   */
  private async prepareFileUploadEnhanced(
    operation: OpenAPIV3.OperationObject, 
    params: Record<string, any>,
    fileOptions?: Partial<FileUploadOptions>
  ): Promise<FormData | null> {
    const fileParams = isFileUploadParameter(operation)
    if (fileParams.length === 0) return null

    const formData = new FormData()

    // Handle file uploads with validation
    for (const param of fileParams) {
      const filePath = params[param]
      if (!filePath) {
        throw new HttpClientError(`File path must be provided for parameter: ${param}`, 400, null)
      }

      switch (typeof filePath) {
        case 'string':
          await this.addValidatedFile(formData, param, filePath, fileOptions)
          break
        case 'object':
          if (Array.isArray(filePath)) {
            for (const file of filePath) {
              await this.addValidatedFile(formData, param, file, fileOptions)
            }
            break
          }
          // deliberate fallthrough
        default:
          throw new HttpClientError(`Unsupported file type: ${typeof filePath}`, 400, { fileType: typeof filePath })
      }
    }

    // Add non-file parameters to form data
    for (const [key, value] of Object.entries(params)) {
      if (!fileParams.includes(key)) {
        formData.append(key, value)
      }
    }

    return formData
  }

  /**
   * Adds a validated file to FormData
   */
  private async addValidatedFile(
    formData: FormData, 
    paramName: string, 
    filePath: string, 
    fileOptions?: Partial<FileUploadOptions>
  ): Promise<void> {
    try {
      // Validate the file
      this.validateFile(filePath, fileOptions)

      // Create file stream
      const fileStream = fs.createReadStream(filePath)
      const fileName = path.basename(filePath)
      const mimeType = this.getMimeType(filePath)

      // Add file to form data with proper metadata
      formData.append(paramName, fileStream, {
        filename: fileName,
        contentType: mimeType
      })
    } catch (error) {
      if (error instanceof HttpClientError) {
        throw error
      }
      throw new HttpClientError(`Failed to read file at ${filePath}: ${error}`, 500, { filePath, error: (error as Error).message })
    }
  }

  /**
   * Legacy file upload method (maintained for backward compatibility)
   */
  private async prepareFileUpload(operation: OpenAPIV3.OperationObject, params: Record<string, any>): Promise<FormData | null> {
    // Use the enhanced version with validation disabled for backward compatibility
    return this.prepareFileUploadEnhanced(operation, params, { 
      validateSize: false, 
      validateType: false 
    })
  }

  /**
   * Specialized method for Notion file upload operations with full validation
   */
  private async prepareNotionFileUpload(
    operation: OpenAPIV3.OperationObject, 
    params: Record<string, any>
  ): Promise<FormData | null> {
    // Check if this is a Notion file upload operation
    const isNotionFileUpload = operation.operationId?.includes('file') || 
                              operation.operationId?.includes('upload') ||
                              operation.summary?.toLowerCase().includes('file')

    if (!isNotionFileUpload) {
      return this.prepareFileUpload(operation, params)
    }

    // Use enhanced validation for Notion file uploads
    return this.prepareFileUploadEnhanced(operation, params, {
      validateSize: true,
      validateType: true,
      maxSizeBytes: DEFAULT_MAX_FILE_SIZE
    })
  }

  /**
   * Helper method to get file information for Notion API
   */
  getFileInfo(filePath: string): { fileName: string; fileSize: number; mimeType: string } {
    this.validateFile(filePath)
    
    const stats = fs.statSync(filePath)
    return {
      fileName: path.basename(filePath),
      fileSize: stats.size,
      mimeType: this.getMimeType(filePath)
    }
  }

  /**
   * Execute an OpenAPI operation
   */
  async executeOperation<T = any>(
    operation: OpenAPIV3.OperationObject & { method: string; path: string },
    params: Record<string, any> = {},
  ): Promise<HttpClientResponse<T>> {
    const api = await this.api
    const operationId = operation.operationId
    if (!operationId) {
      throw new HttpClientError('Operation ID is required', 400, null)
    }

    // Handle file uploads with enhanced validation for Notion operations
    const formData = await this.prepareNotionFileUpload(operation, params)

    // Separate parameters based on their location
    const urlParameters: Record<string, any> = {}
    const bodyParams: Record<string, any> = formData || { ...params }

    // Extract path and query parameters based on operation definition
    if (operation.parameters) {
      for (const param of operation.parameters) {
        if ('name' in param && param.name && param.in) {
          if (param.in === 'path' || param.in === 'query') {
            if (params[param.name] !== undefined) {
              urlParameters[param.name] = params[param.name]
              if (!formData) {
                delete bodyParams[param.name]
              }
            }
          }
        }
      }
    }

    // Add all parameters as url parameters if there is no requestBody defined
    if (!operation.requestBody && !formData) {
      for (const key in bodyParams) {
        if (bodyParams[key] !== undefined) {
          urlParameters[key] = bodyParams[key]
          delete bodyParams[key]
        }
      }
    }

    const operationFn = (api as any)[operationId]
    if (!operationFn) {
      throw new Error(`Operation ${operationId} not found`)
    }

    try {
      // If we have form data, we need to set the correct headers
      const hasBody = Object.keys(bodyParams).length > 0
      const headers = formData
        ? formData.getHeaders()
        : { ...(hasBody ? { 'Content-Type': 'application/json' } : { 'Content-Type': null }) }
      const requestConfig = {
        headers: {
          ...headers,
        },
      }

      // first argument is url parameters, second is body parameters
      const response = await operationFn(urlParameters, hasBody ? bodyParams : undefined, requestConfig)

      // Convert axios headers to Headers object
      const responseHeaders = new Headers()
      Object.entries(response.headers).forEach(([key, value]) => {
        if (value) responseHeaders.append(key, value.toString())
      })

      return {
        data: response.data,
        status: response.status,
        headers: responseHeaders,
      }
    } catch (error: any) {
      // Re-throw HttpClientError from validation
      if (error instanceof HttpClientError) {
        throw error
      }

      if (error.response) {
        console.error('Error in http client', error)
        const headers = new Headers()
        Object.entries(error.response.headers).forEach(([key, value]) => {
          if (value) headers.append(key, value.toString())
        })

        // Enhanced error handling for Notion API specific errors
        let errorMessage = error.response.statusText || 'Request failed'
        
        // Handle rate limiting
        if (error.response.status === 429) {
          const retryAfter = error.response.headers['retry-after'] || error.response.headers['Retry-After']
          errorMessage = `Rate limit exceeded. ${retryAfter ? `Retry after ${retryAfter} seconds.` : ''}`
        }
        
        // Handle file upload specific errors
        if (error.response.status === 413) {
          errorMessage = 'File too large for upload'
        }
        
        if (error.response.status === 415) {
          errorMessage = 'Unsupported media type for file upload'
        }

        throw new HttpClientError(errorMessage, error.response.status, error.response.data, headers)
      }
      
      // Handle network and other errors
      const errorMessage = error.code === 'ENOENT' ? 'File not found' : 
                          error.code === 'EACCES' ? 'File access denied' :
                          error.message || 'Unknown error occurred'
      
      throw new HttpClientError(errorMessage, 500, { originalError: error.message, code: error.code })
    }
  }
}
