/** Normalized raw inputs the sources produce and the linker/distiller consume. */

export interface RawComment {
  body: string
  author?: string
  createdAt: number
}

export interface RawTicket {
  source: 'linear'
  ticketId: string
  identifier?: string // ENG-123
  title: string
  description: string
  state?: string
  labels: string[]
  priority?: string
  urls: string[] // attachments + links found on the ticket
  comments: RawComment[]
  createdAt: number
  updatedAt: number
  completedAt?: number
}

export interface RawThread {
  channel: string
  ts: string // slack thread timestamp — also its id
  permalink?: string
  text: string // opening message
  replies: RawComment[]
  createdAt: number
}

export interface LinkedIncident {
  ticket?: RawTicket
  thread?: RawThread
}

export interface DistilledIncident {
  symptoms: string
  rootCause?: string
  resolution?: string
  investigationSummary?: string
  resolutionSteps: string[]
  errorSignature?: string
}
