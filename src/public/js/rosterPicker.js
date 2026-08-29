// Roster picker for the regular-session Edit/New Session form (Kyle,
// 2026-08-29): the roster table always renders every player in the system
// (saveRoster() needs every player_id/target_games input present so it can
// tell "still enrolled" from "removed" — see admin.js), but showing all of
// them at once got unwieldy once the player pool grew past what fits on one
// screen. This is a pure display layer on top of that same data: nothing
// about which inputs exist or what gets submitted changes, so saveRoster()
// and the roster-summary live-math widget (session_form.ejs's own inline
// script, which sums every target_games input regardless of visibility)
// both keep working completely unchanged.
//
// A row starts visible if the player is already enrolled (target > 0 at
// page load, marked server-side via the .roster-enrolled class) or once the
// admin actually engages with it — types a value into its target field, or
// clicks into it after finding it via search. Typing in the search box
// additionally reveals any *matching* row regardless of enrollment, so a
// player who isn't showing can be found and added. Clearing the search box
// hides rows again unless they've been engaged with. If this script fails
// to load for any reason, every row is still in the DOM with no inline
// style applied — the table just falls back to showing everyone, exactly
// like it did before this feature, so nothing is ever actually lost.
document.addEventListener('DOMContentLoaded', function () {
  var table = document.querySelector('#regular-roster table');
  var searchInput = document.getElementById('roster-search');
  var emptyRow = document.getElementById('roster-empty-row');
  if (!table || !searchInput) return;

  var rows = Array.from(table.querySelectorAll('tbody tr.roster-row'));

  function isAdded(row) {
    return row.dataset.added === 'true';
  }
  function setAdded(row, val) {
    row.dataset.added = val ? 'true' : 'false';
  }

  rows.forEach(function (row) {
    setAdded(row, row.classList.contains('roster-enrolled'));
  });

  function applyVisibility() {
    var query = searchInput.value.trim().toLowerCase();
    var anyVisible = false;
    rows.forEach(function (row) {
      var name = row.dataset.playerName || '';
      var show = isAdded(row) || (query.length > 0 && name.indexOf(query) !== -1);
      row.style.display = show ? '' : 'none';
      if (show) anyVisible = true;
    });
    if (emptyRow) emptyRow.style.display = anyVisible ? 'none' : '';
  }

  rows.forEach(function (row) {
    var targetInput = row.querySelector('input[name="target_games"]');
    var removeBtn = row.querySelector('.remove-player-row');
    if (targetInput) {
      // Engaging with a found-via-search row (clicking into it, or typing a
      // real target) pins it visible so it doesn't vanish out from under the
      // admin the moment they clear the search box.
      targetInput.addEventListener('focus', function () {
        setAdded(row, true);
      });
      targetInput.addEventListener('input', function () {
        if (Number(targetInput.value) > 0) setAdded(row, true);
      });
    }
    if (removeBtn) {
      removeBtn.addEventListener('click', function () {
        if (targetInput) targetInput.value = 0;
        var priorityInput = row.querySelector('input[name="priority"]');
        if (priorityInput) priorityInput.value = '';
        setAdded(row, false);
        applyVisibility();
        // Let the roster-summary widget know the total changed.
        if (targetInput) targetInput.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
  });

  searchInput.addEventListener('input', applyVisibility);
  applyVisibility();
});
