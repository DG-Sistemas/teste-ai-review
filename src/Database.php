<?php

declare(strict_types=1);

final class Database
{
    private static ?PDO $conn = null;

    public static function get(): PDO
    {
        if (self::$conn === null) {
            self::$conn = new PDO(
                sprintf('mysql:host=%s;dbname=%s;charset=utf8mb4', getenv('DB_HOST'), getenv('DB_NAME')),
                getenv('DB_USER'),
                getenv('DB_PASS'),
                [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]
            );
        }
        return self::$conn;
    }
}
