/** A public availability marker is not a live seat count or booking guarantee. */
export interface AwardDate {
  date: string;
  operatingStatus: 'OPERATED' | 'NOT_OPERATED';
  /** NOT_YET_OPEN marks a day past the airline's booking horizon: the calendar
   *  shows it but publishes nothing, so its award fields are null, not false. */
  availabilityType: 'PUBLIC_INDICATOR' | 'NOT_YET_OPEN';
  availableSeatCount: null;
  economyAward: boolean | null;
  premiumAward: boolean | null;
  prestigeAward: boolean | null;
  /** Null when the public marker combines first-class awards and upgrades. */
  firstAward: boolean | null;
  firstAwardOrUpgrade: boolean;
  economyUpgrade: boolean;
  premiumUpgrade: boolean;
  prestigeUpgrade: boolean;
  firstUpgrade: boolean | null;
}

export interface AwardCalendar {
  origin: string;
  destination: string;
  tripType: 'ONE_WAY';
  month: string;
  source: 'KOREAN_AIR_PUBLIC_AWARD_CALENDAR';
  sourceUpdatedAt: string | null;
  collectedAt: string;
  dates: AwardDate[];
}

export interface ParseCalendarOptions {
  origin: string;
  destination: string;
  month: string;
  sourceUpdatedAt: string | null;
  collectedAt: string;
}
