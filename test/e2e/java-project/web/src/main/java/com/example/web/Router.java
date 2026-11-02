package com.example.web;

public class Router {
    public Router() {
    }

    public String route(String path) {
        if (path == null || path.isEmpty()) {
            return "/";
        }
        return path;
    }

    public boolean ok() {
        return true;
    }
}
