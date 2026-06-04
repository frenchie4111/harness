export interface Announcement {
  id: string
  title: string
  href: string
  publishedAt: string
  summary?: string
  expiresAt?: string
}

export interface AnnouncementsState {
  items: Announcement[]
  lastFetched: number | null
  lastError: string | null
}

export type AnnouncementsEvent =
  | {
      type: 'announcements/loaded'
      payload: { items: Announcement[]; fetchedAt: number }
    }
  | { type: 'announcements/fetchFailed'; payload: string }

export const initialAnnouncements: AnnouncementsState = {
  items: [],
  lastFetched: null,
  lastError: null
}

export function announcementsReducer(
  state: AnnouncementsState,
  event: AnnouncementsEvent
): AnnouncementsState {
  switch (event.type) {
    case 'announcements/loaded':
      return {
        items: event.payload.items,
        lastFetched: event.payload.fetchedAt,
        lastError: null
      }
    case 'announcements/fetchFailed':
      return { ...state, lastError: event.payload }
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}
