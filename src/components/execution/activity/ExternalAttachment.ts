export interface ExternalAttachment {
  id: string;
  displayName: string;
  localAbsPath: string;
  isImage: boolean;
  mimeType?: string;
  sizeBytes?: number;
}
