package com.example.core;

import java.util.List;

public class Pricing {
    public Pricing() {
    }

    public int discount(int total) {
        int rate = 0;
        if (total > 500) {
            rate += 10;
        }
        if (total > 50) {
            rate += 5;
        }
        if (total < 0) {
            rate = 0;
        }
        return total - total * rate / 100;
    }

    public int total(int[] prices) {
        int sum = 0;
        for (int price : prices) {
            if (price > 0) {
                sum += price;
            }
        }
        return sum;
    }

    public long names(List<String> items) {
        return items.stream().filter(s -> s != null && !s.isEmpty()).count();
    }

    public static class Tier {
        int rate(String code, int[] steps) {
            if (code == null) {
                return 0;
            }
            return steps.length > 1 ? steps[1] : steps[0];
        }
    }
}
