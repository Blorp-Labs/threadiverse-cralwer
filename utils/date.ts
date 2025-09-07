import { parseISO, isWithinInterval, subDays } from "date-fns";

const ONE_MONTH_AGO = {
  start: subDays(new Date(), 30),
  end: new Date()
}

export const dateLessThanOneMonthAgo = (date: string) => isWithinInterval(parseISO(date),
  ONE_MONTH_AGO
);
