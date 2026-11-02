package com.example;

import java.util.Map;
import java.util.function.Predicate;

// Synthetic source. The tests only need this file to exist; the numbers come from report.xml.
public class Pricing {
    static final int BASE = 10;

    Pricing(String label) {}

    double price(int quantity) {
        return quantity * BASE;
    }

    double price(String label, int quantity) {
        return quantity;
    }

    class Tier {
        double rate() {
            return 1.0;
        }
    }

    Runnable job() {
        return new Runnable() {
            public void run() {}
        };
    }

    void apply(Map.Entry<String, String>[] entries) {
        Predicate<String> a = s -> s.isEmpty();
        Predicate<String> b = s -> !s.isEmpty();
    }
}
