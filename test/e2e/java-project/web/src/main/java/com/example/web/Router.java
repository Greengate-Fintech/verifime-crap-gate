package com.example.web;

public class Router {
    private final String base;

    public Router(String base, int depth) {
        if (base == null) {
            throw new IllegalArgumentException("base");
        }
        this.base = base;
    }

    public String route(String path) {
        if (path.isEmpty()) {
            return "/";
        }
        return path;
    }

    public boolean ok() {
        return true;
    }
}
