/* [Part] */
// Select an individual printable part or an assembled view.
part = "assembly"; // [assembly:Assembly, base:Base, cap:Cap, peg:Peg]

/* [Dimensions] */
// Width of the base in millimeters.
base_width = 20; // [8:1:40]
cap_thickness = 3; // [1:1:8]
with_peg = true;
label_text = "Fixture";
offset = [0, 0, 0];

/* [Hidden] */
internal_dimension = 100;
$fn = 12;

module base() {
    cube([base_width, 12, 4]);
}
module cap() {
    cube([base_width - 2, 10, cap_thickness]);
}
module peg() {
    cube([5, 5, 7]);
}

translate(offset) {
    if (part == "base") base();
    else if (part == "cap") cap();
    else if (part == "peg") peg();
    else if (part == "assembly") {
        base();
        translate([0, 0, 4]) cap();
        if (with_peg) translate([0, 0, 4 + cap_thickness]) peg();
    }
}
