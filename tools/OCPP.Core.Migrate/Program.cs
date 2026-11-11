// Copies an OCPP.Core SQL Server database to a new SQLite database, keeping all primary keys.
//
//   set OCPP_SOURCE=<SQL Server connection string>     (environment, never on the command line)
//   dotnet run --project tools/OCPP.Core.Migrate -- <template.sqlite> <output.sqlite>
//
// The output is created from SQLite/OCPP.Core.Empty.sqlite and migrated with EF (the same
// path the Server takes), then every table is copied and verified against the source.
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using OCPP.Core.Database;

if (args.Length != 2)
{
    Console.Error.WriteLine("Gebruik: OCPP.Core.Migrate <template.sqlite> <output.sqlite>  (bron in env OCPP_SOURCE)");
    return 2;
}
string template = args[0], output = args[1];
string source = Environment.GetEnvironmentVariable("OCPP_SOURCE");
if (string.IsNullOrWhiteSpace(source)) { Console.Error.WriteLine("OCPP_SOURCE ontbreekt"); return 2; }
if (File.Exists(output)) { Console.Error.WriteLine($"{output} bestaat al; kies een nieuw bestand"); return 2; }

File.Copy(template, output);

OCPPCoreContext Src() => new(new DbContextOptionsBuilder<OCPPCoreContext>()
    .UseSqlServer(source, o => o.CommandTimeout(300))
    .ConfigureWarnings(w => w.Ignore(RelationalEventId.PendingModelChangesWarning)).Options);
OCPPCoreContext Dst() => new(new DbContextOptionsBuilder<OCPPCoreContext>()
    .UseSqlite($"Filename={output}")
    .ConfigureWarnings(w => w.Ignore(RelationalEventId.PendingModelChangesWarning)).Options);

using (var dst = Dst()) dst.Database.Migrate();

// Warn about source columns the EF model does not know (they would be lost silently).
var modelColumns = new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase)
{
    ["ChargePoint"] = ["ChargePointId", "Name", "Comment", "Username", "Password", "ClientCertThumb"],
    ["ChargeTags"] = ["TagId", "TagName", "ParentTagId", "ExpiryDate", "Blocked"],
    ["ConnectorStatus"] = ["ChargePointId", "ConnectorId", "ConnectorName", "LastStatus", "LastStatusTime", "LastMeter", "LastMeterTime"],
    ["Transactions"] = ["TransactionId", "Uid", "ChargePointId", "ConnectorId", "StartTagId", "StartTime", "MeterStart", "StartResult", "StopTagId", "StopTime", "MeterStop", "StopReason"],
    ["MessageLog"] = ["LogId", "LogTime", "ChargePointId", "ConnectorId", "Message", "Result", "ErrorCode"],
};
using (var conn = new SqlConnection(source))
{
    conn.Open();
    using var cmd = new SqlCommand("SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS ORDER BY TABLE_NAME", conn);
    using var r = cmd.ExecuteReader();
    var unknown = new List<string>();
    var otherTables = new SortedSet<string>();
    while (r.Read())
    {
        string schema = r.GetString(0), table = r.GetString(1), column = r.GetString(2);
        if (schema == "dbo" && modelColumns.TryGetValue(table, out var cols))
        {
            if (!cols.Contains(column, StringComparer.OrdinalIgnoreCase)) unknown.Add($"{table}.{column}");
        }
        else otherTables.Add($"{schema}.{table}");
    }
    Console.WriteLine($"Andere tabellen in de bron (niet gekopieerd): {(otherTables.Count == 0 ? "geen" : string.Join(", ", otherTables))}");
    if (unknown.Count > 0)
    {
        Console.Error.WriteLine($"Kolommen in de bron die niet in het model zitten: {string.Join(", ", unknown)}");
        return 1;
    }
}

int Copy<T>(string name, Func<OCPPCoreContext, IQueryable<T>> query, Func<OCPPCoreContext, DbSet<T>> set) where T : class
{
    const int batch = 5000;
    int total = 0, page = 0;
    while (true)
    {
        List<T> rows;
        using (var src = Src()) rows = query(src).AsNoTracking().Skip(page * batch).Take(batch).ToList();
        if (rows.Count == 0) break;
        using (var dst = Dst())
        {
            dst.ChangeTracker.AutoDetectChangesEnabled = false;
            set(dst).AddRange(rows);
            dst.SaveChanges();
        }
        total += rows.Count;
        page++;
        if (rows.Count < batch) break;
    }
    Console.WriteLine($"{name,-16} {total,8} rijen");
    return total;
}

// Order matters for foreign keys. Stable ordering by primary key for paging.
Copy("ChargePoint", c => c.ChargePoints.OrderBy(x => x.ChargePointId), c => c.ChargePoints);
Copy("ChargeTags", c => c.ChargeTags.OrderBy(x => x.TagId), c => c.ChargeTags);
Copy("ConnectorStatus", c => c.ConnectorStatuses.OrderBy(x => x.ChargePointId).ThenBy(x => x.ConnectorId), c => c.ConnectorStatuses);
Copy("Transactions", c => c.Transactions.OrderBy(x => x.TransactionId), c => c.Transactions);
Copy("MessageLog", c => c.MessageLogs.OrderBy(x => x.LogId), c => c.MessageLogs);

// Verification: counts, highest ids and energy per charge point must match.
bool ok = true;
void Check(string what, object a, object b)
{
    bool same = Equals(a, b);
    ok &= same;
    Console.WriteLine($"{(same ? "OK " : "FOUT")} {what,-34} bron={a}  doel={b}");
}
using (var s = Src())
using (var d = Dst())
{
    Check("aantal ChargePoint", s.ChargePoints.Count(), d.ChargePoints.Count());
    Check("aantal ChargeTags", s.ChargeTags.Count(), d.ChargeTags.Count());
    Check("aantal ConnectorStatus", s.ConnectorStatuses.Count(), d.ConnectorStatuses.Count());
    Check("aantal Transactions", s.Transactions.Count(), d.Transactions.Count());
    Check("aantal MessageLog", s.MessageLogs.Count(), d.MessageLogs.Count());
    Check("hoogste TransactionId", s.Transactions.Max(t => (int?)t.TransactionId), d.Transactions.Max(t => (int?)t.TransactionId));
    Check("hoogste LogId", s.MessageLogs.Max(t => (int?)t.LogId), d.MessageLogs.Max(t => (int?)t.LogId));
    Check("open transacties (geen StopTime)", s.Transactions.Count(t => t.StopTime == null), d.Transactions.Count(t => t.StopTime == null));

    // Energy per charge point, computed client-side so both providers round the same way.
    string Energy(OCPPCoreContext c) => string.Join("; ", c.Transactions.AsNoTracking()
        .Where(t => t.MeterStop != null).Select(t => new { t.ChargePointId, t.MeterStart, t.MeterStop }).ToList()
        .GroupBy(t => t.ChargePointId).OrderBy(g => g.Key)
        .Select(g => $"{g.Key}={Math.Round(g.Sum(t => t.MeterStop!.Value - t.MeterStart), 3)} kWh"));
    Check("geladen energie per laadpaal", Energy(s), Energy(d));

    var srcLast = s.Transactions.OrderByDescending(t => t.TransactionId).Select(t => new { t.TransactionId, t.StartTime, t.StopTime, t.MeterStart, t.MeterStop }).FirstOrDefault()?.ToString();
    var dstLast = d.Transactions.OrderByDescending(t => t.TransactionId).Select(t => new { t.TransactionId, t.StartTime, t.StopTime, t.MeterStart, t.MeterStop }).FirstOrDefault()?.ToString();
    Check("laatste transactie identiek", srcLast, dstLast);
}

// The SQLite AUTOINCREMENT counters must continue after the copied ids.
using (var d = Dst())
{
    var seq = d.Database.SqlQueryRaw<string>("SELECT name || '=' || seq AS Value FROM sqlite_sequence ORDER BY name").ToList();
    Console.WriteLine($"sqlite_sequence: {(seq.Count == 0 ? "(leeg)" : string.Join(", ", seq))}");
}

Console.WriteLine(ok ? $"Migratie geslaagd: {output}" : "Migratie NIET in orde, zie FOUT-regels");
return ok ? 0 : 1;
