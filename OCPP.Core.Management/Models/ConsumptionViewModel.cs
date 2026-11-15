using System.Collections.Generic;

namespace OCPP.Core.Management.Models
{
    /// <summary>
    /// Charged energy per month and per year (all charge points and tags together).
    /// A session counts in the month (local time) in which it started; running sessions are not included.
    /// </summary>
    public class ConsumptionViewModel
    {
        public int Year { get; set; }

        /// <summary>12 entries, January..December of <see cref="Year"/></summary>
        public List<ConsumptionPeriod> Months { get; set; } = new List<ConsumptionPeriod>();

        /// <summary>12 entries for the year before, for comparison</summary>
        public List<ConsumptionPeriod> PreviousMonths { get; set; } = new List<ConsumptionPeriod>();

        /// <summary>All years with data, oldest first</summary>
        public List<ConsumptionPeriod> Years { get; set; } = new List<ConsumptionPeriod>();

        public double TotalEnergy { get; set; }
        public int TotalSessions { get; set; }

        /// <summary>Number of months of <see cref="Year"/> that have started (12 for past years)</summary>
        public int MonthsElapsed { get; set; }

        /// <summary>The previous year over the same period (up to today for the current year), for the comparison</summary>
        public double? PreviousSamePeriodEnergy { get; set; }

        public bool IsCurrentYear { get; set; }
    }

    public class ConsumptionPeriod
    {
        public int Year { get; set; }
        public int Month { get; set; }
        public double Energy { get; set; }
        public int Sessions { get; set; }
    }
}
