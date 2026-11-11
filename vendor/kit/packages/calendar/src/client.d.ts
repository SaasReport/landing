export interface ClientOptions { baseUrl: string; fetch?: typeof fetch; profile?: "bank" | "government" | "market" }
export class KitCalendarClient {
  constructor(o: ClientOptions);
  today(): Promise<any>; day(date: string): Promise<any>; month(year: number, month: number): Promise<any>; holidays(year: number): Promise<any>;
  businessDays(from: string, to: string): Promise<any>; add(date: string, days: number, type?: "business" | "calendar"): Promise<any>;
  adjust(date: string, convention?: string): Promise<any>; settlement(date: string, o?: { t?: number }): Promise<any>;
  schedule(p: { start: string; count?: number; amount?: number; convention?: string; day?: number; interval?: number }): Promise<any>;
}
