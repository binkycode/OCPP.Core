using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using OCPP.Core.Management.Models;

namespace OCPP.Core.Management.Controllers
{
    public partial class HomeController : BaseController
    {
        /// <summary>
        /// Charged energy per month and per year. All tags and charge points together (one car).
        /// </summary>
        [Authorize]
        public IActionResult Consumption(int? year)
        {
            try
            {
                TimeZoneInfo tz = LocalTimeZone();

                // Small table (a few thousand rows): aggregate in memory, so the
                // UTC -> local conversion is exact for every session.
                var sessions = DbContext.Transactions.AsNoTracking()
                    .Where(t => t.MeterStop != null)
                    .Select(t => new { t.StartTime, t.MeterStart, t.MeterStop })
                    .ToList()
                    .Where(t => t.MeterStop.Value >= t.MeterStart)
                    .Select(t => new
                    {
                        Start = TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(t.StartTime, DateTimeKind.Utc), tz),
                        Energy = t.MeterStop.Value - t.MeterStart
                    })
                    .ToList();

                DateTime now = TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, tz);
                var model = new ConsumptionViewModel
                {
                    Year = year ?? now.Year
                };
                model.IsCurrentYear = model.Year == now.Year;
                model.MonthsElapsed = model.Year < now.Year ? 12 : (model.IsCurrentYear ? now.Month : 0);

                List<ConsumptionPeriod> MonthsOf(int y) => Enumerable.Range(1, 12)
                    .Select(m =>
                    {
                        var inMonth = sessions.Where(s => s.Start.Year == y && s.Start.Month == m).ToList();
                        return new ConsumptionPeriod { Year = y, Month = m, Energy = inMonth.Sum(s => s.Energy), Sessions = inMonth.Count };
                    })
                    .ToList();

                model.Months = MonthsOf(model.Year);
                model.PreviousMonths = MonthsOf(model.Year - 1);
                model.Years = sessions
                    .GroupBy(s => s.Start.Year)
                    .OrderBy(g => g.Key)
                    .Select(g => new ConsumptionPeriod { Year = g.Key, Energy = g.Sum(s => s.Energy), Sessions = g.Count() })
                    .ToList();
                model.TotalEnergy = model.Months.Sum(m => m.Energy);
                model.TotalSessions = model.Months.Sum(m => m.Sessions);

                // Compare with the previous year over the same period: up to the same day for the current year.
                var previous = sessions.Where(s => s.Start.Year == model.Year - 1);
                if (model.IsCurrentYear) previous = previous.Where(s => s.Start <= now.AddYears(-1));
                var previousList = previous.ToList();
                model.PreviousSamePeriodEnergy = previousList.Count > 0 ? previousList.Sum(s => s.Energy) : null;

                return View(model);
            }
            catch (Exception exp)
            {
                Logger.LogError(exp, "Consumption: Error loading transactions from database");
                TempData["ErrMessage"] = exp.Message;
                return RedirectToAction("Error", new { Id = "" });
            }
        }

        private static TimeZoneInfo LocalTimeZone()
        {
            try
            {
                return TimeZoneInfo.FindSystemTimeZoneById("Europe/Brussels");
            }
            catch (Exception)
            {
                return TimeZoneInfo.Local;
            }
        }
    }
}
